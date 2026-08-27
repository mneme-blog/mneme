package api

import (
	"encoding/base64"
	"net/http"
	"regexp"

	"github.com/mneme-blog/mneme/server/internal/store"
)

const maxPullLimit = 500

// maxPushEntries bounds one push batch. The body is size-capped at 32 MiB, but
// a 32 MiB batch of tiny entries is thousands of individual round-trips in a
// loop — capping the count mirrors maxPullLimit and keeps one request from
// turning into an unbounded burst of sequential writes.
const maxPushEntries = 500

// recordIDRe constrains the oplog's primary key. media_id has always been
// validated because it becomes an object-storage key; entry_id — which is
// stored, indexed, and echoed back on every pull — only had a non-empty check,
// so an authenticated owner could key records by megabyte-long ids (up to the
// 32 MiB body limit, 500 per request) and grow a column the storage quota's
// ciphertext accounting never sees.
//
// Deliberately wider than the ids the client mints (random 128-bit hex): a
// record pushed by an older build must keep pushing, so anything that has ever
// been a plausible id — the sample entries' "e1", a notebook's "j-tutorial" —
// still passes. It is a bound, not a format.
var recordIDRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

// POST /v1/sync/push — upload encrypted entry blobs. Last-write-wins per entry on
// lww_clock. The server treats ciphertext as opaque bytes.
func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID

	var req struct {
		Entries []struct {
			EntryID    string `json:"entry_id"`
			LWWClock   int64  `json:"lww_clock"`
			Ciphertext string `json:"ciphertext"` // base64
			Deleted    bool   `json:"deleted"`
		} `json:"entries"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	if len(req.Entries) > maxPushEntries {
		writeError(w, http.StatusRequestEntityTooLarge, "too many entries in one push")
		return
	}

	// Pre-flight quota check. Tombstones are exempt: refusing a deletion would
	// leave an over-quota vault unable to free space, which is the one thing it
	// has to be able to do.
	var incoming int64
	for _, e := range req.Entries {
		if !e.Deleted {
			incoming += int64(len(e.Ciphertext))
		}
	}
	if incoming > 0 && s.quotaExceeded(r.Context(), w, owner, incoming) {
		return
	}

	type result struct {
		EntryID string `json:"entry_id"`
		Applied bool   `json:"applied"`
	}
	results := make([]result, 0, len(req.Entries))
	var created, updated, deleted int64

	for _, e := range req.Entries {
		if !recordIDRe.MatchString(e.EntryID) {
			writeError(w, http.StatusBadRequest, "entry_id must be 1-128 characters of [A-Za-z0-9_.:-]")
			return
		}
		ct, err := base64.StdEncoding.DecodeString(e.Ciphertext)
		if err != nil {
			writeError(w, http.StatusBadRequest, "ciphertext must be base64")
			return
		}
		// Opaque, but a well-formed blob carries at least the version byte (§3).
		if len(ct) < 1 {
			writeError(w, http.StatusBadRequest, "ciphertext is empty")
			return
		}
		applied, isNew, err := s.store.PushEntry(r.Context(), owner, store.EntryBlob{
			EntryID:    e.EntryID,
			LWWClock:   e.LWWClock,
			Ciphertext: ct,
			Deleted:    e.Deleted,
		})
		if err != nil {
			writeInternalError(w, r, "push failed", err)
			return
		}
		switch {
		case applied && e.Deleted:
			deleted++
		case applied && isNew:
			created++
		case applied:
			updated++
		}
		results = append(results, result{EntryID: e.EntryID, Applied: applied})
	}

	// Aggregate counters only — never tied to the owner (see internal/store/stats.go).
	s.metrics.bump(metricRecordsCreated, created)
	s.metrics.bump(metricRecordsUpdated, updated)
	s.metrics.bump(metricRecordsDeleted, deleted)

	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

// POST /v1/sync/pull — download entries changed since a cursor. Returns the next
// cursor; when it equals the request cursor, the client is fully caught up.
func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID

	var req struct {
		Since int64 `json:"since"`
		Limit int   `json:"limit"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	limit := req.Limit
	if limit <= 0 || limit > maxPullLimit {
		limit = maxPullLimit
	}

	entries, err := s.store.PullEntries(r.Context(), owner, req.Since, limit)
	if err != nil {
		writeInternalError(w, r, "pull failed", err)
		return
	}

	type item struct {
		EntryID    string `json:"entry_id"`
		LWWClock   int64  `json:"lww_clock"`
		Ciphertext string `json:"ciphertext"`
		Deleted    bool   `json:"deleted"`
		Seq        int64  `json:"seq"`
	}
	out := make([]item, 0, len(entries))
	cursor := req.Since
	for _, e := range entries {
		out = append(out, item{
			EntryID:    e.EntryID,
			LWWClock:   e.LWWClock,
			Ciphertext: base64.StdEncoding.EncodeToString(e.Ciphertext),
			Deleted:    e.Deleted,
			Seq:        e.Seq,
		})
		cursor = e.Seq
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"entries": out,
		"cursor":  cursor,
		"more":    len(entries) == limit,
	})
}
