package api

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/mneme-blog/mneme/server/internal/backup"
)

// Operator backup surface (admin-gated, like the rest of /admin). A backup archive
// is a full copy of every vault's opaque ciphertext blobs and media chunks — no
// keys, no plaintext (the relay never has any). Restore is the destructive half of
// disaster recovery and is gated behind a typed confirmation, exactly like vault
// deletion. All of this is a 404 unless ADMIN_TOKEN is set (adminAuth).

// GET /admin/backups — service status plus the listing of stored archives.
func (s *Server) handleAdminListBackups(w http.ResponseWriter, r *http.Request) {
	status, err := s.backup.Status()
	if err != nil {
		writeInternalError(w, r, "backup listing failed", err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// POST /admin/backups — trigger a backup now. The write can take a while on a large
// media set, so it runs detached: this returns 202 immediately and the dashboard
// polls GET /admin/backups for the new archive (and any error) via the status.
func (s *Server) handleAdminCreateBackup(w http.ResponseWriter, r *http.Request) {
	if !s.backup.Enabled() {
		writeError(w, http.StatusServiceUnavailable, "backups disabled (BACKUP_DIR not set)")
		return
	}
	// A detached run must outlive this request, so it gets its own bounded context
	// rather than the request's (which is cancelled once we respond).
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		rec, err := s.backup.RunNow(ctx)
		if err != nil {
			if errors.Is(err, backup.ErrBusy) {
				log.Printf("admin: backup already running")
				return
			}
			log.Printf("admin: backup failed: %v", err)
			return
		}
		log.Printf("admin: backup wrote %s (%d bytes)", rec.Name, rec.Bytes)
	}()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "started"})
}

// POST /admin/backups/{name}/ticket — mint a short-lived, single-use URL the
// browser can download by itself.
//
// The dashboard cannot fetch an archive the way it fetches everything else: an
// Authorization header only rides on fetch/XHR, which means buffering the whole
// archive in the tab before a byte reaches disk. See internal/api/ticket.go for
// why that had to go and what the ticket is worth.
func (s *Server) handleAdminBackupTicket(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	// Confirm the archive exists (and that the name is well-formed) before
	// handing out a ticket, so a bad name is a clean 404 here rather than a
	// download that mysteriously fails a moment later.
	rc, _, err := s.backup.Open(name)
	if err != nil {
		writeBackupErr(w, err)
		return
	}
	_ = rc.Close()

	val, err := s.downloadTickets.issue(name, time.Now())
	if err != nil {
		writeInternalError(w, r, "could not issue a download ticket", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"ticket": val,
		// Relative on purpose: the relay does not know the public origin or the
		// reverse-proxy prefix it is served under, and the dashboard resolves
		// this against its own URL.
		"url": "backups/" + url.PathEscape(name) + "?ticket=" + url.QueryEscape(val),
	})
}

// GET /admin/backups/{name} — download one archive as a gzip stream.
//
// Authorized EITHER by the admin token (curl, scripts, the documented API) or by
// a single-use ticket in the query string (the dashboard's own button, which is
// a plain browser navigation and so cannot send a header). Both paths are
// checked here rather than in adminAuth, because the route has to be reachable
// without an Authorization header at all.
func (s *Server) handleAdminDownloadBackup(w http.ResponseWriter, r *http.Request) {
	if s.cfg.AdminToken == "" {
		http.NotFound(w, r) // /admin does not exist without a token — as everywhere else
		return
	}
	name := r.PathValue("name")
	if !s.authorizeDownload(w, r, name) {
		return
	}
	rc, size, err := s.backup.Open(name)
	if err != nil {
		writeBackupErr(w, err)
		return
	}
	defer rc.Close() //nolint:errcheck // read-only stream

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	// A big archive over a slow link must not trip the server-wide WriteTimeout
	// mid-stream. Best-effort, like the restore handler's own extension.
	// (A wrapper that cannot set deadlines just keeps the global one.)
	if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil &&
		!errors.Is(err, http.ErrNotSupported) {
		log.Printf("admin: could not lift the download write deadline: %v", err)
	}
	if _, err := io.Copy(w, rc); err != nil {
		// The header is already sent; nothing useful to return to the client.
		log.Printf("admin: backup download %s interrupted: %v", name, err)
	}
}

// authorizeDownload accepts the admin token or a ticket scoped to name, and
// writes the rejection itself. Failed attempts spend from the same per-IP budget
// as a failed admin authentication: the ticket is 256 random bits, but it is
// guessable in principle and lives on an endpoint with no other gate.
func (s *Server) authorizeDownload(w http.ResponseWriter, r *http.Request, name string) bool {
	if token, ok := bearerToken(r); ok &&
		subtle.ConstantTimeCompare([]byte(token), []byte(s.cfg.AdminToken)) == 1 {
		return true
	}
	if s.downloadTickets.redeem(r.URL.Query().Get("ticket"), name, time.Now()) {
		return true
	}
	if !s.adminLimiter.allow(clientIP(r, s.cfg.TrustProxyHeaders), time.Now()) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "too many failed admin authentications")
		return false
	}
	writeError(w, http.StatusUnauthorized, "invalid admin token")
	return false
}

// DELETE /admin/backups/{name} — remove one stored archive.
func (s *Server) handleAdminDeleteBackup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.backup.Delete(name); err != nil {
		writeBackupErr(w, err)
		return
	}
	log.Printf("admin: backup %s deleted", name)
	w.WriteHeader(http.StatusNoContent)
}

// POST /admin/backups/{name}/restore — disaster recovery from a stored archive. This
// REPLACES all relay data (see store.Restore), so the body must carry the literal
// confirmation, enforced server-side just like vault deletion:
//
//	{"confirm": "restore"}
//
// It is the convenience path; the `journald restore` CLI is the recommended one for
// true DR (it runs against a stopped/fresh server). Runs synchronously so the
// operator sees the outcome — a restore is a deliberate, one-off action.
func (s *Server) handleAdminRestoreBackup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Confirm string `json:"confirm"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if !confirmed(w, req.Confirm, "restore") {
		return
	}
	name := r.PathValue("name")
	// A full restore can be slow; give it room beyond a default request deadline.
	// That includes the CONNECTION's deadline: the server-wide WriteTimeout
	// (5 min) would sever this response mid-restore and report failure to the
	// operator for an operation that then succeeds server-side. Best-effort —
	// a wrapper that can't set deadlines just keeps the global one.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(35 * time.Minute)); err != nil {
		log.Printf("admin: could not extend the restore response deadline: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	man, err := s.backup.RestoreFrom(ctx, name)
	if err != nil {
		if errors.Is(err, backup.ErrBadName) || errors.Is(err, backup.ErrNotFound) {
			writeBackupErr(w, err)
			return
		}
		// Already logged with full detail above; the response stays generic.
		// Admin-gated, so the exposure is small — but a raw error string here
		// can carry filesystem paths and driver internals, and there is no
		// reason for the dashboard to need them when the log has them.
		log.Printf("admin: restore from %s failed: %v", name, err)
		writeError(w, http.StatusInternalServerError, "restore failed — see the server log")
		return
	}
	log.Printf("admin: restored from %s (%d entries, %d media across %d vaults)",
		name, man.Counts.Entries, man.Counts.Media, man.Counts.Owners)
	writeJSON(w, http.StatusOK, map[string]any{
		"restored":   name,
		"created_at": man.CreatedAt,
		"counts":     man.Counts,
	})
}

// writeBackupErr maps service errors onto HTTP statuses.
func writeBackupErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, backup.ErrDisabled):
		writeError(w, http.StatusServiceUnavailable, "backups disabled (BACKUP_DIR not set)")
	case errors.Is(err, backup.ErrBadName):
		writeError(w, http.StatusBadRequest, "invalid backup name")
	case errors.Is(err, backup.ErrNotFound):
		writeError(w, http.StatusNotFound, "no such backup")
	case errors.Is(err, backup.ErrBusy):
		writeError(w, http.StatusConflict, "a backup is already in progress")
	default:
		log.Printf("admin: backup op failed: %v", err)
		writeError(w, http.StatusInternalServerError, "backup operation failed")
	}
}
