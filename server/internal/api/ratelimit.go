package api

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Rate limiting for the three unauthenticated endpoints (/v1/register,
// /v1/auth/challenge, /v1/auth/verify).
//
// Without it, anyone could create unlimited owners and — with REQUIRE_APPROVAL
// off, the default — push unlimited blobs, i.e. consume arbitrary storage with
// no authenticated actor and no backstop. handleChallenge additionally inserts
// an auth_challenges row per call for any known device_id, so the table could
// be flooded between the 15-minute purges.
//
// A token bucket per client IP. In-process and best-effort by design: the relay
// is one binary serving a homelab or family (§7), so there is no shared state to
// coordinate and no reason to reach for Redis. It bounds accidental and casual
// abuse; it is not a defence against a distributed attacker, which belongs at
// the reverse proxy.

type bucket struct {
	tokens float64
	last   time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	// rate is tokens added per second; burst is the bucket ceiling.
	rate    float64
	burst   float64
	lastGC  time.Time
	enabled bool
}

func newRateLimiter(perMinute int, burst int) *rateLimiter {
	return &rateLimiter{
		buckets: map[string]*bucket{},
		rate:    float64(perMinute) / 60,
		burst:   float64(burst),
		lastGC:  time.Now(),
		// 0 or negative disables the limiter entirely — the documented escape
		// hatch for an operator who fronts the relay with their own throttle.
		enabled: perMinute > 0 && burst > 0,
	}
}

// allow consumes one token for key, reporting whether the request may proceed.
func (l *rateLimiter) allow(key string, now time.Time) bool {
	if !l.enabled {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	// Opportunistic GC: buckets that have had time to refill completely carry no
	// information, so dropping them can't let anyone exceed their allowance.
	if now.Sub(l.lastGC) > 10*time.Minute {
		full := time.Duration(l.burst/l.rate) * time.Second
		for k, b := range l.buckets {
			if now.Sub(b.last) > full {
				delete(l.buckets, k)
			}
		}
		l.lastGC = now
	}

	b, ok := l.buckets[key]
	if !ok {
		l.buckets[key] = &bucket{tokens: l.burst - 1, last: now}
		return true
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// limit wraps a handler with per-IP rate limiting.
func (s *Server) limit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authLimiter.allow(clientIP(r, s.cfg.TrustProxyHeaders), time.Now()) {
			w.Header().Set("Retry-After", "60")
			writeError(w, http.StatusTooManyRequests, "too many requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP is the bucket key. X-Forwarded-For is honoured only when
// TRUST_PROXY_HEADERS is set, because a client can send that header itself:
// trusting it unconditionally would turn the limiter into a no-op for anyone
// who knows to spoof it, while ignoring it behind a real proxy would bucket
// every user together under the proxy's address.
//
// The RIGHT-most entry is used, not the left-most. Proxies (Caddy included)
// *append* to X-Forwarded-For rather than replacing it, so a client that sends
// its own header keeps its value at the front — reading the left-most entry
// would hand the attacker the bucket key. The right-most entry is the one the
// nearest proxy wrote, which is the only one that isn't caller-controlled.
// This therefore assumes exactly one trusted hop, which is what
// TRUST_PROXY_HEADERS asserts.
func clientIP(r *http.Request, trustProxyHeaders bool) string {
	if trustProxyHeaders {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.LastIndexByte(xff, ','); i >= 0 {
				xff = xff[i+1:]
			}
			if ip := strings.TrimSpace(xff); ip != "" {
				return ip
			}
		}
		// X-Real-IP is single-valued: a proxy that sets it overwrites it.
		if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
			return ip
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
