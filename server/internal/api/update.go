package api

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/mneme-blog/mneme/server/internal/deploy"
	"github.com/mneme-blog/mneme/server/migrations"
)

// One-click updates, admin-gated like the rest of /admin.
//
// These handlers do not update anything. They validate what the operator asked
// for and hand it to the host agent through the spool directory (internal/deploy
// explains why the relay must not do this itself). Everything after that —
// backup, pull, restart, health gate, automatic rollback — happens on the host,
// outside this process's lifetime, because this process is what gets replaced.
//
// The whole surface is inert unless UPDATE_SPOOL_DIR is set: without an agent
// installed there is nothing to hand a request to, and the dashboard falls back
// to the informational "a newer version is available" banner.

// logTailLines is how much of the agent's log the dashboard shows. Enough to see
// what a run did, short enough that polling it is cheap.
const logTailLines = 200

// GET /admin/update — everything the dashboard needs to render the panel:
// the version comparison, what the agent is doing, and what a rollback would cost.
func (s *Server) handleAdminUpdateStatus(w http.ResponseWriter, r *http.Request) {
	status := s.spool.Status(logTailLines)
	version := s.updates.info(r.Context())

	// What undoing the *currently installed* version would cost. Unlike the
	// pre-update estimate in versionInfo, this one is answerable locally: this
	// build knows its own breaking migrations, and the agent recorded the schema
	// head of the version it replaced.
	rollback := map[string]any{
		"available": status.State.Previous != "",
		"target":    status.State.Previous,
		"cost":      "unknown",
	}
	if m, err := migrations.Describe(); err == nil {
		if prev := status.State.PreviousSchema; prev > 0 {
			if prev >= m.MinSafeSchema {
				rollback["cost"] = "fast"
			} else {
				rollback["cost"] = "deep"
			}
		}
		rollback["min_safe_schema"] = m.MinSafeSchema
	}
	rollback["backup_archive"] = status.State.BackupArchive

	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":  status.Enabled,
		"version":  version,
		"state":    status.State,
		"pending":  status.Pending,
		"log":      status.Log,
		"rollback": rollback,
		"error":    status.Error,
	})
}

// POST /admin/update — apply a release.
//
//	{"confirm": "update", "tag": "v0.3.0"}
//
// The confirmation string is enforced server-side for the same reason vault
// deletion enforces one: a stray request holding a valid token must not be able
// to restart the stack. The tag is validated against a strict version pattern
// before it is written anywhere — the agent builds an image reference out of it.
func (s *Server) handleAdminUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm string `json:"confirm"`
		Tag     string `json:"tag"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !confirmed(w, req.Confirm, "update") {
		return
	}
	if !deploy.ValidTag(req.Tag) {
		writeError(w, http.StatusBadRequest, "tag must be a release version like v0.3.0 or a main build like main-1a2b3c4")
		return
	}
	s.submitUpdate(w, deploy.Request{
		ID:          newRequestID(),
		Action:      deploy.ActionUpdate,
		Tag:         req.Tag,
		RequestedAt: time.Now().UTC(),
	})
}

// POST /admin/update/rollback — go back to the previously installed version.
//
//	{"confirm": "rollback"}          fast: swap the image back
//	{"confirm": "rollback", "deep": true}
//	                                 destructive: rebuild the database at the old
//	                                 schema and replay the pre-update archive
//
// The target is deliberately NOT taken from the request. After a bad update the
// relay is the component that is wrong; the agent's own record of what it
// replaced is the trustworthy source, and it is the one that has it.
func (s *Server) handleAdminRollback(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm string `json:"confirm"`
		Deep    bool   `json:"deep"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !confirmed(w, req.Confirm, "rollback") {
		return
	}
	status := s.spool.Status(0)
	if status.Enabled && status.State.Previous == "" {
		writeError(w, http.StatusBadRequest, "no previously installed version is recorded")
		return
	}
	if req.Deep && status.State.BackupArchive == "" {
		writeError(w, http.StatusBadRequest, "a deep rollback needs the pre-update backup archive, which is not recorded")
		return
	}
	s.submitUpdate(w, deploy.Request{
		ID:          newRequestID(),
		Action:      deploy.ActionRollback,
		Deep:        req.Deep,
		RequestedAt: time.Now().UTC(),
	})
}

// submitUpdate is the shared tail of both endpoints: queue it, or explain why not.
func (s *Server) submitUpdate(w http.ResponseWriter, req deploy.Request) {
	err := s.spool.Submit(req)
	switch {
	case err == nil:
		log.Printf("admin: queued %s request %s (tag=%q deep=%v)", req.Action, req.ID, req.Tag, req.Deep)
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "queued", "request_id": req.ID})
	case errors.Is(err, deploy.ErrDisabled):
		writeError(w, http.StatusServiceUnavailable,
			"one-click updates are not enabled (set UPDATE_SPOOL_DIR and install the updater agent — see docs/MAINTENANCE.md)")
	case errors.Is(err, deploy.ErrBusy):
		writeError(w, http.StatusConflict, "an update is already in progress")
	default:
		log.Printf("admin: update request failed: %v", err)
		writeError(w, http.StatusInternalServerError, "could not queue the update")
	}
}

// newRequestID correlates a queued request with the state the agent writes back.
// Not a secret and not a credential — just an identifier the dashboard can match.
func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// The ID is only for correlation; a timestamp is a fine degradation and
		// far better than failing the operator's update over an RNG hiccup.
		return "ts-" + time.Now().UTC().Format("20060102T150405.000")
	}
	return hex.EncodeToString(b[:])
}
