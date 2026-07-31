package api

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/plasticparticle/mneme/server/internal/backup"
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
		writeError(w, http.StatusInternalServerError, "backup listing failed")
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

// GET /admin/backups/{name} — download one archive as an octet-stream.
func (s *Server) handleAdminDownloadBackup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	rc, size, err := s.backup.Open(name)
	if err != nil {
		writeBackupErr(w, err)
		return
	}
	defer rc.Close() //nolint:errcheck // read-only stream

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	if _, err := io.Copy(w, rc); err != nil {
		// The header is already sent; nothing useful to return to the client.
		log.Printf("admin: backup download %s interrupted: %v", name, err)
	}
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
	if req.Confirm != "restore" {
		writeError(w, http.StatusBadRequest, `confirmation required: {"confirm":"restore"}`)
		return
	}
	name := r.PathValue("name")
	// A full restore can be slow; give it room beyond a default request deadline.
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
