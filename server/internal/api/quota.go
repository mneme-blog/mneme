package api

import (
	"context"
	"log"
	"net/http"
)

// Per-owner storage quota (QUOTA_BYTES_PER_OWNER; 0 = unlimited).
//
// maxMediaChunks caps a single media object at ~10 GiB but says nothing about
// how many objects an owner may create, and the entry oplog had no cap at all —
// so one authenticated owner could fill the relay's disk. Unlimited stays the
// default because the intended deployment is a single-tenant/family homelab
// (§7); anything internet-facing should set a number.
//
// The check is a pre-flight against current usage, not a transactional
// reservation: a burst of concurrent writes can overshoot the limit by roughly
// one batch. That is the right trade here — the goal is bounding runaway
// growth, and paying for a serialized accounting table on every push would cost
// more than the overshoot does.

// quotaExceeded reports whether the owner is already at or over its limit, and
// writes the 413 if so. incoming is the size of the write being attempted.
func (s *Server) quotaExceeded(w http.ResponseWriter, ctx context.Context, owner string, incoming int64) bool {
	limit := s.cfg.Quota.BytesPerOwner
	if limit <= 0 {
		return false
	}
	used, err := s.store.OwnerStorageBytes(ctx, owner)
	if err != nil {
		// Fail closed: a quota that silently stops applying when the DB hiccups
		// is not a quota.
		log.Printf("quota lookup failed: %v", err)
		writeError(w, http.StatusInternalServerError, "could not verify storage quota")
		return true
	}
	if used+incoming <= limit {
		return false
	}
	// 413 rather than 507: from the client's side this is "your request is too
	// big for what you're allowed", and the client surfaces it as such.
	writeError(w, http.StatusRequestEntityTooLarge, "storage quota exceeded for this vault")
	return true
}
