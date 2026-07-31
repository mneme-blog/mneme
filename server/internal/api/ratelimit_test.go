package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRateLimiterBurstThenRefill(t *testing.T) {
	// 60/minute = 1 token per second, burst 3.
	l := newRateLimiter(60, 3)
	now := time.Unix(1_700_000_000, 0)

	for i := 0; i < 3; i++ {
		if !l.allow("1.2.3.4", now) {
			t.Fatalf("request %d within burst was denied", i+1)
		}
	}
	if l.allow("1.2.3.4", now) {
		t.Fatal("request past the burst should be denied")
	}

	// A different client has its own bucket.
	if !l.allow("5.6.7.8", now) {
		t.Fatal("a different IP should not be affected by another's bucket")
	}

	// One second later, one token is back — and only one.
	if !l.allow("1.2.3.4", now.Add(time.Second)) {
		t.Fatal("a token should have refilled after a second")
	}
	if l.allow("1.2.3.4", now.Add(time.Second)) {
		t.Fatal("only one token should have refilled")
	}

	// Long idle refills to the burst ceiling, not beyond it.
	later := now.Add(time.Hour)
	for i := 0; i < 3; i++ {
		if !l.allow("1.2.3.4", later) {
			t.Fatalf("request %d after idle refill was denied", i+1)
		}
	}
	if l.allow("1.2.3.4", later) {
		t.Fatal("refill should be capped at the burst size")
	}
}

func TestRateLimiterDisabled(t *testing.T) {
	l := newRateLimiter(0, 0)
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < 1000; i++ {
		if !l.allow("1.2.3.4", now) {
			t.Fatal("a disabled limiter must allow everything")
		}
	}
}

// Auth endpoints are throttled; health probes are not, so a monitoring loop
// can't lock itself out.
func TestAuthEndpointsAreRateLimited(t *testing.T) {
	cfg := testConfig()
	cfg.RateLimit.AuthPerMinute = 60
	cfg.RateLimit.AuthBurst = 2
	srv := New(nil, nil, cfg)
	h := srv.Routes()

	post := func(path string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, nil)
		req.RemoteAddr = "9.9.9.9:1234"
		h.ServeHTTP(rec, req)
		return rec.Code
	}

	// The bucket is shared across the three auth paths — it keys on the client,
	// not the route, so spreading the spam around doesn't buy more budget.
	_ = post("/v1/register")
	_ = post("/v1/auth/challenge")
	if got := post("/v1/auth/verify"); got != http.StatusTooManyRequests {
		t.Fatalf("third auth call = %d, want 429", got)
	}

	for i := 0; i < 5; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		req.RemoteAddr = "9.9.9.9:1234"
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("health probe %d = %d, want 200 (probes must not be throttled)", i, rec.Code)
		}
	}
}

// X-Forwarded-For must be ignored unless the operator says the relay is behind
// a proxy — otherwise anyone can rotate the header and bypass the limiter.
func TestClientIPIgnoresForwardedHeaderByDefault(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/v1/register", nil)
	req.RemoteAddr = "10.0.0.1:5555"
	req.Header.Set("X-Forwarded-For", "1.1.1.1")

	if got := clientIP(req, false); got != "10.0.0.1" {
		t.Fatalf("clientIP without trust = %q, want the socket address", got)
	}
	if got := clientIP(req, true); got != "1.1.1.1" {
		t.Fatalf("clientIP with trust = %q, want the forwarded address", got)
	}

	// Proxies APPEND to X-Forwarded-For, so a client that sends its own header
	// keeps its value at the front. Reading the left-most entry would let the
	// caller pick its own rate-limit bucket; the right-most is what the nearest
	// (trusted) proxy wrote.
	req.Header.Set("X-Forwarded-For", "6.6.6.6, 203.0.113.7")
	if got := clientIP(req, true); got != "203.0.113.7" {
		t.Fatalf("clientIP with a spoofed prefix = %q, want the proxy-appended entry", got)
	}
}
