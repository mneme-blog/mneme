package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func adminConfig(token string) Server {
	cfg := testConfig()
	cfg.AdminToken = token
	return Server{cfg: cfg, metrics: newMetrics()}
}

func get(t *testing.T, srv *Server, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	srv.Routes().ServeHTTP(rec, req)
	return rec
}

func TestAdminDisabledWithoutToken(t *testing.T) {
	srv := New(nil, nil, testConfig()) // no ADMIN_TOKEN
	for _, path := range []string{"/admin", "/admin/", "/admin/stats"} {
		if rec := get(t, srv, path, nil); rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404 (admin surface must not exist when unconfigured)", path, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/admin/vaults/abc", strings.NewReader(`{"confirm":"delete"}`)))
	if rec.Code != http.StatusNotFound {
		t.Errorf("DELETE /admin/vaults = %d, want 404 when admin is unconfigured", rec.Code)
	}
}

func TestAdminDeleteVaultRequiresConfirmString(t *testing.T) {
	srv := adminConfig("s3cret")
	del := func(body string, withToken bool) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodDelete, "/admin/vaults/some-owner-id", strings.NewReader(body))
		if withToken {
			req.Header.Set("Authorization", "Bearer s3cret")
		}
		srv.Routes().ServeHTTP(rec, req)
		return rec.Code
	}
	if code := del(`{"confirm":"delete"}`, false); code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", code)
	}
	// The typed confirmation is enforced server-side, before any store access —
	// these run against a nil store and must fail on validation alone.
	if code := del(`{}`, true); code != http.StatusBadRequest {
		t.Errorf("missing confirm = %d, want 400", code)
	}
	if code := del(`{"confirm":"DELETE"}`, true); code != http.StatusBadRequest {
		t.Errorf("wrong-case confirm = %d, want 400 (must be the literal lowercase string)", code)
	}
	if code := del(``, true); code != http.StatusBadRequest {
		t.Errorf("empty body = %d, want 400", code)
	}
}

func TestAdminStatsRejectsBadToken(t *testing.T) {
	srv := adminConfig("s3cret")
	if rec := get(t, &srv, "/admin/stats", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("no token = %d, want 401", rec.Code)
	}
	if rec := get(t, &srv, "/admin/stats", map[string]string{"Authorization": "Bearer wrong"}); rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong token = %d, want 401", rec.Code)
	}
}

func TestAdminPageServedWhenEnabled(t *testing.T) {
	srv := adminConfig("s3cret")
	rec := get(t, &srv, "/admin", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /admin = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", ct)
	}
	if !strings.Contains(rec.Body.String(), "Mneme relay") {
		t.Fatal("dashboard HTML not served")
	}
}

func TestMetricsBufferDrainAndRestore(t *testing.T) {
	m := newMetrics()
	m.bump(metricRecordsCreated, 3)
	m.bump(metricRecordsCreated, 2)
	m.observe(http.StatusOK, 5*time.Millisecond)
	m.observe(http.StatusBadRequest, 15*time.Millisecond)

	counts := m.drain()
	if counts[metricRecordsCreated] != 5 {
		t.Errorf("records_created = %d, want 5", counts[metricRecordsCreated])
	}
	if counts[metricRequests] != 2 || counts[metricRequestsFailed] != 1 {
		t.Errorf("requests = %d/%d failed, want 2/1", counts[metricRequests], counts[metricRequestsFailed])
	}
	if again := m.drain(); again != nil {
		t.Errorf("second drain = %v, want nil", again)
	}

	// A failed flush must not lose counts.
	m.restore(counts)
	if c := m.drain(); c[metricRecordsCreated] != 5 {
		t.Errorf("after restore records_created = %d, want 5", c[metricRecordsCreated])
	}

	rt := m.runtime()
	if rt.Requests != 2 || rt.Failed4xx != 1 || rt.Failed5xx != 0 {
		t.Errorf("runtime = %+v, want 2 requests / 1 4xx / 0 5xx", rt)
	}
	if rt.AvgLatencyMs < 9 || rt.AvgLatencyMs > 11 || rt.MaxLatencyMs != 15 {
		t.Errorf("latency avg=%v max=%v, want ~10/15", rt.AvgLatencyMs, rt.MaxLatencyMs)
	}
}

func TestVaultLabelTruncates(t *testing.T) {
	if got := vaultLabel("abcdefghijklmnop"); got != "abcdefgh…" {
		t.Errorf("vaultLabel = %q", got)
	}
	if got := vaultLabel("short"); got != "short" {
		t.Errorf("vaultLabel(short) = %q", got)
	}
}

func TestRequestMetricsCountOnlyV1(t *testing.T) {
	srv := adminConfig("s3cret")
	get(t, &srv, "/healthz", nil)
	get(t, &srv, "/admin", nil)
	if rt := srv.metrics.runtime(); rt.Requests != 0 {
		t.Fatalf("non-/v1 traffic counted: %d requests", rt.Requests)
	}
	// 401 from the auth middleware — still a /v1 request, observed before any store access.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/sync/pull", nil)
	srv.Routes().ServeHTTP(rec, req)
	if rt := srv.metrics.runtime(); rt.Requests != 1 || rt.Failed4xx != 1 {
		t.Fatalf("runtime = %+v, want 1 request / 1 4xx", rt)
	}
}

// Guessing ADMIN_TOKEN is throttled per client IP. Only failures are charged, so
// a dashboard holding the right token keeps polling at any rate it likes.
func TestAdminTokenGuessesAreThrottled(t *testing.T) {
	cfg := testConfig()
	cfg.AdminToken = "correct-horse"
	cfg.RateLimit.AdminPerMinute = 6
	cfg.RateLimit.AdminBurst = 3
	srv := New(nil, nil, cfg)

	bad := map[string]string{"Authorization": "Bearer wrong"}
	for i := 0; i < cfg.RateLimit.AdminBurst; i++ {
		if rec := get(t, srv, "/admin/stats", bad); rec.Code != http.StatusUnauthorized {
			t.Fatalf("guess %d = %d, want 401", i+1, rec.Code)
		}
	}
	rec := get(t, srv, "/admin/stats", bad)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("guess past the burst = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("a throttled admin response should say when to come back")
	}

	// A valid token is never charged, so the operator is not locked out by an
	// attacker sharing their address — and the dashboard's polling is free.
	good := map[string]string{"Authorization": "Bearer correct-horse"}
	if rec := get(t, srv, "/admin/version", good); rec.Code != http.StatusOK {
		t.Errorf("authenticated admin request = %d, want 200", rec.Code)
	}
}
