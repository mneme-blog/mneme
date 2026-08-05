package api

import (
	"net/http"
	"strconv"
	"sync"
	"time"
)

// The transcription gate.
//
// The deployment bundles a speech-to-text server and proxies it under the app's
// own origin so the client's default endpoint needs no CORS or CSP config. That
// route cannot be behind the relay in the usual sense: the browser posts the
// decrypted recording straight to the speech server, and routing it through this
// process instead would put journal plaintext through the relay — the one thing
// the architecture forbids (CLAUDE.md §2, docs/SECURITY.md §2).
//
// So the relay authorizes without touching the audio. Caddy asks this endpoint
// (`forward_auth`, which rewrites the sub-request to a bodyless GET) whether a
// call may proceed; on 2xx it forwards the request to the speech server, and on
// anything else it answers the client with what this endpoint said and never
// wakes the speech server at all. The relay therefore sees the session token and
// the declared upload size, and never a byte of audio.
//
// What that buys, in order of importance:
//   - only a device holding a valid vault session can spend transcription CPU;
//   - a per-vault quota bounds the day (TranscribeConfig, in-memory);
//   - a per-vault token bucket bounds the burst;
//   - the expensive container is unreachable to anyone who is not signed in.
const (
	// headerTranscribeKind says which endpoint is being authorized. Set by the
	// proxy (deploy/web/Caddyfile), one value per allowlisted route, so the
	// quota charge can apply to actual transcriptions and not to a settings
	// sheet checking whether the server is up.
	headerTranscribeKind = "X-Mneme-Transcribe-Kind"
	// headerUploadBytes carries the original request's Content-Length, which the
	// bodyless auth sub-request would otherwise lose.
	headerUploadBytes = "X-Mneme-Upload-Bytes"

	kindTranscribe = "transcribe" // POST /v1/audio/transcriptions — charged
	kindModels     = "models"     // GET  /v1/models — free (no audio, no work)
	kindInstall    = "install"    // POST /v1/models/{pinned} — free, but authenticated
)

// transcribeQuota counts one UTC day of usage per owner, in memory.
//
// In memory on purpose, and not only for simplicity: persisting it would have
// the relay write down how often each vault transcribes, which is a per-owner
// behavioural record it has no other reason to keep (§3 accepted leaks are
// deliberately short). The cost is that a restart forgives the day's usage —
// acceptable for a bound whose job is to stop runaway use, not to bill.
type transcribeQuota struct {
	maxRequests int
	maxBytes    int64

	mu   sync.Mutex
	day  string // UTC date the counters below belong to
	used map[string]transcribeUse
}

type transcribeUse struct {
	requests int
	bytes    int64
}

func newTranscribeQuota(maxRequests int, maxMegabytes int64) *transcribeQuota {
	return &transcribeQuota{
		maxRequests: maxRequests,
		maxBytes:    maxMegabytes << 20,
		used:        map[string]transcribeUse{},
	}
}

// charge books one transcription against owner. ok=false means the vault is out
// of budget for today; retryAfter is how long until the counters roll over.
func (q *transcribeQuota) charge(owner string, bytes int64, now time.Time) (ok bool, retryAfter time.Duration) {
	if q == nil || (q.maxRequests <= 0 && q.maxBytes <= 0) {
		return true, 0
	}
	utc := now.UTC()
	day := utc.Format("2006-01-02")

	q.mu.Lock()
	defer q.mu.Unlock()

	// A new day drops every counter at once — which is also what keeps the map
	// from growing without bound.
	if day != q.day {
		q.day = day
		q.used = map[string]transcribeUse{}
	}

	u := q.used[owner]
	if q.maxRequests > 0 && u.requests >= q.maxRequests {
		return false, untilNextDay(utc)
	}
	if q.maxBytes > 0 && u.bytes+bytes > q.maxBytes {
		return false, untilNextDay(utc)
	}
	u.requests++
	u.bytes += bytes
	q.used[owner] = u
	return true, 0
}

func untilNextDay(utc time.Time) time.Duration {
	midnight := time.Date(utc.Year(), utc.Month(), utc.Day(), 0, 0, 0, 0, time.UTC).Add(24 * time.Hour)
	return midnight.Sub(utc)
}

// GET /v1/transcribe/authorize — may this session send a recording to the
// bundled speech server?
//
// 204 yes · 401 no session (from the auth middleware) · 429 rate/quota.
// The answers are deliberately bare: the caller owns the vault, so it learns
// nothing it does not already know, and a passer-by learns nothing at all.
func (s *Server) handleTranscribeAuthorize(w http.ResponseWriter, r *http.Request) {
	owner := principalOf(r.Context()).OwnerID

	if !s.transcribeLimiter.allow(owner, time.Now()) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "too many transcription requests — try again shortly")
		return
	}

	// Only actual transcriptions cost quota. Listing models is what the settings
	// sheet's "Check server" does and it neither sends audio nor starts work;
	// charging it would let a person exhaust their day by opening a settings
	// page. An unknown or absent kind is treated as a transcription — the
	// header comes from the proxy, and the safe default is to charge.
	switch r.Header.Get(headerTranscribeKind) {
	case kindModels, kindInstall:
		w.WriteHeader(http.StatusNoContent)
		return
	}

	bytes, _ := strconv.ParseInt(r.Header.Get(headerUploadBytes), 10, 64)
	if bytes < 0 {
		bytes = 0
	}
	if ok, retry := s.transcribeQuota.charge(owner, bytes, time.Now()); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "daily transcription limit reached for this vault")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// transcribeGate fronts the authorize route with the per-IP bucket that guards
// the unauthenticated endpoints.
//
// Charged only when the request turns out to have no valid session, so a
// signed-in device never spends from it however often it transcribes. Without
// this, an unauthenticated caller could make the relay do a session lookup per
// request forever — cheap for them, a database round-trip for us.
func (s *Server) transcribeGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r, s.cfg.TrustProxyHeaders)
		if !s.authLimiter.available(ip, time.Now()) {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "too many requests")
			return
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if sw.status == http.StatusUnauthorized || sw.status == http.StatusForbidden {
			s.authLimiter.charge(ip, time.Now())
		}
	})
}
