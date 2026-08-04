package api

import (
	"crypto/subtle"
	_ "embed"
	"log"
	"net/http"
	"time"

	"github.com/plasticparticle/mneme/server/internal/store"
)

// The admin surface shows only what the relay already stores as accepted
// metadata (§3): vault counts, ciphertext sizes, timestamps, and owner-less
// daily aggregates. It can never show content, identities, or per-vault
// activity history — the data for that does not exist server-side.
//
// Enabled only when ADMIN_TOKEN is set; otherwise every /admin path is a 404,
// indistinguishable from a route that does not exist.

//go:embed dashboard.html
var dashboardHTML []byte

// adminAuth gates an admin endpoint behind the configured token.
//
// Failed attempts are rate-limited per client IP. The comparison is
// constant-time, which stops a timing attack but says nothing about how many
// guesses a caller may make — and this is the most powerful surface on the
// relay (vault deletion, backup download, restore, a stack restart onto a chosen
// release) behind one static token an operator picks by hand. The three
// unauthenticated client endpoints have been throttled since the last audit; the
// one that can destroy every vault was not.
//
// Only failures consume budget, so the dashboard's polling — which holds a valid
// token and polls every few seconds during an update — is never affected.
func (s *Server) adminAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.AdminToken == "" {
			http.NotFound(w, r)
			return
		}
		token, ok := bearerToken(r)
		if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.AdminToken)) != 1 {
			if !s.adminLimiter.allow(clientIP(r, s.cfg.TrustProxyHeaders), time.Now()) {
				w.Header().Set("Retry-After", "60")
				writeError(w, http.StatusTooManyRequests, "too many failed admin authentications")
				return
			}
			writeError(w, http.StatusUnauthorized, "invalid admin token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// GET /admin — the dashboard page. Static HTML with no data baked in; the page
// itself asks for the token and fetches /admin/stats with it.
func (s *Server) handleAdminPage(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AdminToken == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// Overrides the API-wide default-src 'none' from secureHeaders: this is the
	// one response that is a document. Hash-pinned inline script, no external
	// origin, not framable — see headers.go.
	w.Header().Set("Content-Security-Policy", dashboardCSP)
	_, _ = w.Write(dashboardHTML)
}

// vaultLabel truncates an opaque owner id for display. The full id is already
// pseudonymous (a pubkey hash); the prefix is just enough to track a vault's
// footprint over time without inviting cross-referencing.
func vaultLabel(ownerID string) string {
	if len(ownerID) > 8 {
		return ownerID[:8] + "…"
	}
	return ownerID
}

// GET /admin/stats — aggregate health/usage snapshot as JSON.
func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request) {
	vaults, err := s.store.ListVaultStats(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "vault stats failed")
		return
	}
	daily, err := s.store.UsageHistory(r.Context(), 30)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "usage history failed")
		return
	}

	type vaultRow struct {
		Vault        string     `json:"vault"`    // truncated opaque id for display, not an identity
		OwnerID      string     `json:"owner_id"` // full opaque id — needed to address a vault for deletion
		Status       string     `json:"status"`   // pending | approved | rejected
		ApprovalHint string     `json:"approval_hint"`
		CreatedAt    time.Time  `json:"created_at"`
		Devices      int64      `json:"devices"`
		Records      int64      `json:"records"`
		RecordBytes  int64      `json:"record_bytes"`
		MediaObjects int64      `json:"media_objects"`
		MediaBytes   int64      `json:"media_bytes"`
		LastActivity *time.Time `json:"last_activity"`
	}
	type totals struct {
		Vaults       int64 `json:"vaults"`
		Devices      int64 `json:"devices"`
		Records      int64 `json:"records"`
		RecordBytes  int64 `json:"record_bytes"`
		MediaObjects int64 `json:"media_objects"`
		MediaBytes   int64 `json:"media_bytes"`
	}
	type dayRow struct {
		Day    string           `json:"day"`
		Counts map[string]int64 `json:"counts"`
	}

	var t totals
	rows := make([]vaultRow, 0, len(vaults))
	for _, v := range vaults {
		t.Vaults++
		t.Devices += v.Devices
		t.Records += v.Records
		t.RecordBytes += v.RecordBytes
		t.MediaObjects += v.MediaObjects
		t.MediaBytes += v.MediaBytes
		rows = append(rows, vaultRow{
			Vault:        vaultLabel(v.OwnerID),
			OwnerID:      v.OwnerID,
			Status:       v.Status,
			ApprovalHint: v.ApprovalHint,
			CreatedAt:    v.CreatedAt.UTC(),
			Devices:      v.Devices,
			Records:      v.Records,
			RecordBytes:  v.RecordBytes,
			MediaObjects: v.MediaObjects,
			MediaBytes:   v.MediaBytes,
			LastActivity: v.LastActivity,
		})
	}

	days := make([]dayRow, 0, len(daily))
	for _, d := range daily {
		days = append(days, dayRow{Day: d.Day, Counts: d.Counts})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"totals":           t,
		"vaults":           rows,
		"daily":            days,
		"runtime":          s.metrics.runtime(),
		"require_approval": s.cfg.RequireApproval,
	})
}

// setOwnerStatus is the shared body of the approve/reject admin endpoints.
func (s *Server) setOwnerStatus(w http.ResponseWriter, r *http.Request, status string) {
	ownerID := r.PathValue("id")
	found, err := s.store.SetOwnerStatus(r.Context(), ownerID, status)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "status update failed")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "no such vault")
		return
	}
	log.Printf("admin: vault %s -> %s", vaultLabel(ownerID), status)
	w.WriteHeader(http.StatusNoContent)
}

// POST /admin/owners/{id}/approve — let a pending (or previously rejected) vault
// authenticate. Only meaningful when REQUIRE_APPROVAL gated it in the first place;
// harmless otherwise (owners are already approved).
func (s *Server) handleAdminApproveOwner(w http.ResponseWriter, r *http.Request) {
	s.setOwnerStatus(w, r, store.OwnerStatusApproved)
}

// POST /admin/owners/{id}/reject — deny a vault. Enforcement is immediate: the
// auth middleware reads the live status, so an already-signed-in owner is cut off
// on its next request. Rejecting keeps the (opaque) data; use DELETE to wipe it.
func (s *Server) handleAdminRejectOwner(w http.ResponseWriter, r *http.Request) {
	s.setOwnerStatus(w, r, store.OwnerStatusRejected)
}

// DELETE /admin/vaults/{id} — operator-initiated vault wipe (e.g. reclaiming
// quota from an abandoned vault). The body must carry the literal confirmation
// string — enforced server-side, not just in the dashboard UI — so a stray
// request with a valid token can't destroy a vault:
//
//	{"confirm": "delete"}
//
// Destroys the same data as self-service DELETE /v1/account. It does NOT touch
// any device's local copy — the relay has no reach into clients, by design.
func (s *Server) handleAdminDeleteVault(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm string `json:"confirm"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Confirm != "delete" {
		writeError(w, http.StatusBadRequest, `confirmation required: {"confirm":"delete"}`)
		return
	}
	ownerID := r.PathValue("id")
	found, err := s.wipeOwner(r.Context(), ownerID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "vault deletion failed")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "no such vault")
		return
	}
	log.Printf("admin: vault %s deleted", vaultLabel(ownerID))
	w.WriteHeader(http.StatusNoContent)
}
