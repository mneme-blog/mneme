package api

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"

	"github.com/plasticparticle/mneme/server/internal/blobs"
	"github.com/plasticparticle/mneme/server/internal/store"
)

// Media transfer is server-relayed (§12 resolved; see internal/blobs): the client
// uploads each ~1 MiB client-encrypted chunk through the relay, then finalizes the
// object so other devices can discover its chunk count. The relay sees only the
// random media_id and chunk sizes — never content, mime type, or duration (those
// live inside the encrypted entry body).

// maxChunkBytes bounds one encrypted chunk: 1 MiB plaintext + AEAD framing, with headroom.
const maxChunkBytes = 2 << 20

// maxMediaChunks bounds one media object (~10 GiB) — a sanity cap, not a quota.
const maxMediaChunks = 10_000

// Random hex/base64url ids only — also keeps the derived S3 key path-safe.
var mediaIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

// ownerMediaPrefix is the key prefix covering EVERY media object of one owner.
// The trailing slash matters: without it "media/abc" would also match the keys
// of an owner id that merely starts with "abc".
func ownerMediaPrefix(ownerID string) string {
	return fmt.Sprintf("media/%s/", ownerID)
}

func mediaKeyPrefix(ownerID, mediaID string) string {
	return fmt.Sprintf("media/%s/%s", ownerID, mediaID)
}

func chunkKey(ownerID, mediaID string, n int) string {
	return fmt.Sprintf("%s/%d", mediaKeyPrefix(ownerID, mediaID), n)
}

// mediaParams validates the {id} (and optional {n}) path segments.
func mediaParams(w http.ResponseWriter, r *http.Request, wantChunk bool) (mediaID string, n int, ok bool) {
	mediaID = r.PathValue("id")
	if !mediaIDRe.MatchString(mediaID) {
		writeError(w, http.StatusBadRequest, "invalid media id")
		return "", 0, false
	}
	if !wantChunk {
		return mediaID, 0, true
	}
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 0 || n >= maxMediaChunks {
		writeError(w, http.StatusBadRequest, "invalid chunk index")
		return "", 0, false
	}
	return mediaID, n, true
}

// writeBlobErr maps blob-store failures onto HTTP statuses.
func writeBlobErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, blobs.ErrNotConfigured):
		writeError(w, http.StatusServiceUnavailable, "media storage not configured")
	case errors.Is(err, blobs.ErrNotFound):
		writeError(w, http.StatusNotFound, "chunk not found")
	default:
		log.Printf("media blob store: %v", err)
		writeError(w, http.StatusInternalServerError, "media storage failed")
	}
}

// PUT /v1/media/{id}/chunks/{n} — upload one encrypted chunk (raw octet-stream body).
func (s *Server) handlePutMediaChunk(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID
	mediaID, n, ok := mediaParams(w, r, true)
	if !ok {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxChunkBytes))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "chunk too large")
		return
	}
	// Opaque, but a well-formed blob carries at least the version byte (§3).
	if len(body) == 0 {
		writeError(w, http.StatusBadRequest, "chunk is empty")
		return
	}
	if err := s.blobs.Put(r.Context(), chunkKey(owner, mediaID, n), body); err != nil {
		writeBlobErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"media_id": mediaID, "chunk": n})
}

// POST /v1/media/{id}/complete — finalize an upload so other devices can fetch it.
func (s *Server) handleCompleteMedia(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID
	mediaID, _, ok := mediaParams(w, r, false)
	if !ok {
		return
	}
	var req struct {
		Chunks int   `json:"chunks"`
		Bytes  int64 `json:"bytes"` // total ciphertext bytes, for bookkeeping only
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Chunks < 1 || req.Chunks > maxMediaChunks || req.Bytes < 1 {
		writeError(w, http.StatusBadRequest, "invalid chunks/bytes")
		return
	}
	created, err := s.store.FinalizeMedia(r.Context(), owner, store.MediaBlob{
		MediaID: mediaID,
		S3Key:   mediaKeyPrefix(owner, mediaID),
		Bytes:   req.Bytes,
		Chunks:  req.Chunks,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "finalize failed")
		return
	}
	if created {
		// "An encrypted media object of N bytes" is all the relay can know — the
		// kind (video/audio/image/file) lives inside the ciphertext.
		s.metrics.bump(metricMediaUploaded, 1)
		s.metrics.bump(metricMediaBytes, req.Bytes)
	}
	writeJSON(w, http.StatusOK, map[string]any{"media_id": mediaID})
}

// GET /v1/media/{id} — metadata for a finalized media object.
func (s *Server) handleGetMedia(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID
	mediaID, _, ok := mediaParams(w, r, false)
	if !ok {
		return
	}
	m, err := s.store.GetMedia(r.Context(), owner, mediaID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "media not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "media lookup failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"media_id": m.MediaID,
		"bytes":    m.Bytes,
		"chunks":   m.Chunks,
	})
}

// DELETE /v1/media/{id} — remove one media object: the index row first, then a
// best-effort sweep of its ciphertext chunks (same pattern as account deletion).
// Idempotent: deleting an id the relay never saw (or already deleted) succeeds,
// so the client's offline deletion queue can retry safely.
func (s *Server) handleDeleteMedia(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID
	mediaID, _, ok := mediaParams(w, r, false)
	if !ok {
		return
	}
	// The index row is best-effort here: an object with chunks on disk but no
	// index row (an upload that was never completed) must still be deletable,
	// so a missing row is not a reason to skip the chunk sweep.
	if _, err := s.store.GetMedia(r.Context(), owner, mediaID); err != nil && !errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusInternalServerError, "media lookup failed")
		return
	}
	if err := s.store.DeleteMedia(r.Context(), owner, mediaID); err != nil {
		writeError(w, http.StatusInternalServerError, "media deletion failed")
		return
	}
	// Sweep the object prefix rather than the indexed chunk range: chunks
	// uploaded but never finalized have no index row, and keying cleanup off
	// the index is exactly what used to leave them behind forever. The prefix
	// embeds the authenticated owner, so this cannot reach another tenant.
	if _, err := s.blobs.DeletePrefix(r.Context(), mediaKeyPrefix(owner, mediaID)+"/"); err != nil &&
		!errors.Is(err, blobs.ErrNotConfigured) && !errors.Is(err, blobs.ErrNotFound) {
		// A failure here only orphans opaque ciphertext that nothing
		// references anymore; the client's deletion queue retries.
		log.Printf("media delete: chunk sweep for %s failed: %v", mediaID, err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// GET /v1/media/{id}/chunks/{n} — download one encrypted chunk.
func (s *Server) handleGetMediaChunk(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID
	mediaID, n, ok := mediaParams(w, r, true)
	if !ok {
		return
	}
	data, err := s.blobs.Get(r.Context(), chunkKey(owner, mediaID, n))
	if err != nil {
		writeBlobErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if _, err := w.Write(data); err != nil {
		return
	}
}
