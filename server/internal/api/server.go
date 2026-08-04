package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/plasticparticle/mneme/server/internal/backup"
	"github.com/plasticparticle/mneme/server/internal/blobs"
	"github.com/plasticparticle/mneme/server/internal/config"
	"github.com/plasticparticle/mneme/server/internal/deploy"
	"github.com/plasticparticle/mneme/server/internal/store"
	"github.com/plasticparticle/mneme/server/migrations"
)

type Server struct {
	store   *store.Store
	blobs   blobs.Store
	cfg     config.Config
	metrics *metrics
	backup  *backup.Service
	updates *updateChecker
	// spool hands one-click update requests to the host agent. Disabled (and the
	// endpoints inert) unless UPDATE_SPOOL_DIR is set.
	spool *deploy.Spool
	// authLimiter throttles the unauthenticated endpoints — the only way into
	// the relay, and so the only place an anonymous caller can cost anything.
	authLimiter *rateLimiter
	// adminLimiter bounds guesses at ADMIN_TOKEN. Charged on failure only, so a
	// dashboard holding a valid token never spends from it (see adminAuth).
	adminLimiter *rateLimiter
}

func New(st *store.Store, bl blobs.Store, cfg config.Config) *Server {
	if bl == nil {
		bl = blobs.Disabled{}
	}
	// The compiled-in schema head feeds the update check's rollback estimate. A
	// parse failure here would mean a migration is missing its rollback marker,
	// which store.Migrate already refuses to start with; degrade to 0 ("unknown")
	// rather than making the constructor fallible.
	schema := 0
	if m, err := migrations.Describe(); err == nil {
		schema = m.Schema
	}
	return &Server{
		store:        st,
		blobs:        bl,
		cfg:          cfg,
		metrics:      newMetrics(),
		backup:       backup.NewService(cfg.Backup.Dir, cfg.Backup.Keep, st, bl),
		updates:      newUpdateChecker(cfg.Version, schema, cfg.UpdateCheck),
		spool:        deploy.NewSpool(cfg.UpdateSpoolDir),
		authLimiter:  newRateLimiter(cfg.RateLimit.AuthPerMinute, cfg.RateLimit.AuthBurst),
		adminLimiter: newRateLimiter(cfg.RateLimit.AdminPerMinute, cfg.RateLimit.AdminBurst),
	}
}

// RunBackups drives the scheduled backup worker until ctx is cancelled. It is a
// no-op unless BACKUP_DIR is configured. Called from cmd/journald alongside the
// other background workers.
func (s *Server) RunBackups(ctx context.Context) {
	s.backup.Run(ctx, s.cfg.Backup.Interval)
}

// Routes builds the HTTP handler. Uses Go 1.22 method+pattern routing — no router dep.
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// Public. The three auth endpoints are rate-limited per client IP: they are
	// unauthenticated, and without a limit an anonymous caller can create
	// unlimited owners, push unlimited blobs, and flood auth_challenges.
	// Health probes stay unthrottled so a monitoring loop can't lock itself out.
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("GET /readyz", s.handleReady)
	mux.Handle("POST /v1/register", s.limit(http.HandlerFunc(s.handleRegister)))
	mux.Handle("POST /v1/auth/challenge", s.limit(http.HandlerFunc(s.handleChallenge)))
	mux.Handle("POST /v1/auth/verify", s.limit(http.HandlerFunc(s.handleVerify)))

	// Authenticated (owner-scoped)
	mux.Handle("POST /v1/sync/push", s.auth(http.HandlerFunc(s.handlePush)))
	mux.Handle("POST /v1/sync/pull", s.auth(http.HandlerFunc(s.handlePull)))
	mux.Handle("GET /v1/reminders", s.auth(http.HandlerFunc(s.handleListReminders)))
	mux.Handle("PUT /v1/reminders", s.auth(http.HandlerFunc(s.handlePutReminder)))
	mux.Handle("DELETE /v1/reminders/{id}", s.auth(http.HandlerFunc(s.handleDeleteReminder)))
	mux.Handle("PUT /v1/media/{id}/chunks/{n}", s.auth(http.HandlerFunc(s.handlePutMediaChunk)))
	mux.Handle("POST /v1/media/{id}/complete", s.auth(http.HandlerFunc(s.handleCompleteMedia)))
	mux.Handle("GET /v1/media/{id}", s.auth(http.HandlerFunc(s.handleGetMedia)))
	mux.Handle("GET /v1/media/{id}/chunks/{n}", s.auth(http.HandlerFunc(s.handleGetMediaChunk)))
	mux.Handle("DELETE /v1/media/{id}", s.auth(http.HandlerFunc(s.handleDeleteMedia)))
	mux.Handle("DELETE /v1/account", s.auth(http.HandlerFunc(s.handleDeleteAccount)))

	// Admin (aggregate stats only; every path is a 404 unless ADMIN_TOKEN is set)
	mux.HandleFunc("GET /admin", s.handleAdminPage)
	mux.HandleFunc("GET /admin/{$}", s.handleAdminPage)
	mux.Handle("GET /admin/stats", s.adminAuth(http.HandlerFunc(s.handleAdminStats)))
	mux.Handle("GET /admin/version", s.adminAuth(http.HandlerFunc(s.handleAdminVersion)))
	mux.Handle("DELETE /admin/vaults/{id}", s.adminAuth(http.HandlerFunc(s.handleAdminDeleteVault)))
	mux.Handle("POST /admin/owners/{id}/approve", s.adminAuth(http.HandlerFunc(s.handleAdminApproveOwner)))
	mux.Handle("POST /admin/owners/{id}/reject", s.adminAuth(http.HandlerFunc(s.handleAdminRejectOwner)))
	mux.Handle("GET /admin/backups", s.adminAuth(http.HandlerFunc(s.handleAdminListBackups)))
	mux.Handle("POST /admin/backups", s.adminAuth(http.HandlerFunc(s.handleAdminCreateBackup)))
	mux.Handle("GET /admin/backups/{name}", s.adminAuth(http.HandlerFunc(s.handleAdminDownloadBackup)))
	mux.Handle("DELETE /admin/backups/{name}", s.adminAuth(http.HandlerFunc(s.handleAdminDeleteBackup)))
	mux.Handle("POST /admin/backups/{name}/restore", s.adminAuth(http.HandlerFunc(s.handleAdminRestoreBackup)))
	mux.Handle("GET /admin/update", s.adminAuth(http.HandlerFunc(s.handleAdminUpdateStatus)))
	mux.Handle("POST /admin/update", s.adminAuth(http.HandlerFunc(s.handleAdminUpdate)))
	mux.Handle("POST /admin/update/rollback", s.adminAuth(http.HandlerFunc(s.handleAdminRollback)))

	return s.secureHeaders(s.cors(s.logging(mux)))
}

// ── auth context ────────────────────────────────────────────────────────────

type ctxKey int

const principalKey ctxKey = iota

type principal struct {
	OwnerID  string
	DeviceID string
}

func principalOf(ctx context.Context) principal {
	p, _ := ctx.Value(principalKey).(principal)
	return p
}

// auth validates the Bearer session token and injects the owner/device principal.
// Tenant isolation lives here: every authenticated handler reads owner_id from the
// principal, never from the request body.
func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerToken(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		hash := sha256.Sum256([]byte(token))
		ownerID, deviceID, status, err := s.store.LookupSession(r.Context(), hash[:])
		if err != nil {
			writeError(w, http.StatusUnauthorized, "invalid or expired session")
			return
		}
		// Approval gate (REQUIRE_APPROVAL): read on every request so an operator's
		// reject/revoke takes effect on the owner's next call, not when the session
		// expires. With approval off, every owner is 'approved' and this never trips.
		if status != store.OwnerStatusApproved {
			writeError(w, http.StatusForbidden, "vault has not been approved by the operator")
			return
		}
		ctx := context.WithValue(r.Context(), principalKey, principal{OwnerID: ownerID, DeviceID: deviceID})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func bearerToken(r *http.Request) (string, bool) {
	h := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if len(h) > len(prefix) && strings.EqualFold(h[:len(prefix)], prefix) {
		return strings.TrimSpace(h[len(prefix):]), true
	}
	return "", false
}

// ── helpers ─────────────────────────────────────────────────────────────────

// deriveID is the stable public identifier for a public key: base64url(sha256(pub)).
func deriveID(pub []byte) string {
	sum := sha256.Sum256(pub)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (s *Server) logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		elapsed := time.Since(start)
		// Only client API traffic counts as a "request" — health probes and the
		// admin's own polling would otherwise drown the dashboard's numbers.
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			s.metrics.observe(sw.status, elapsed)
		}
		log.Printf("%s %s -> %d (%s)", r.Method, r.URL.Path, sw.status, elapsed.Round(time.Millisecond))
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}
