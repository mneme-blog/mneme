package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSemverLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"v0.1.0", "v0.2.0", true},
		{"v0.1.0", "v0.1.1", true},
		{"v0.1.0", "v1.0.0", true},
		{"v1.2.3", "v1.2.3", false}, // equal → not less
		{"v2.0.0", "v1.9.9", false}, // newer current
		{"0.1.0", "0.2.0", true},    // missing v prefix still parses
		{"v0.1.0+abc123", "v0.2.0", true},
		{"v0.2.0-rc1", "v0.2.0", false}, // prerelease suffix ignored → equal core
		{"dev", "v0.2.0", false},        // unparseable current → never nag
		{"v0.1.0", "nightly", false},    // unparseable latest → no claim
		{"v0.1", "v0.2.0", false},       // malformed (2 parts) → false
	}
	for _, c := range cases {
		if got := semverLess(c.a, c.b); got != c.want {
			t.Errorf("semverLess(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// fakeGitHub serves a canned releases/latest payload and counts hits.
func fakeGitHub(t *testing.T, tag, htmlURL string) (*httptest.Server, *int) {
	t.Helper()
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_ = json.NewEncoder(w).Encode(map[string]string{
			"tag_name": tag, "html_url": htmlURL, "name": tag, "body": "release notes",
		})
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func newTestChecker(current string, enabled bool, apiURL string) *updateChecker {
	u := newUpdateChecker(current, 0, enabled)
	u.apiURL = apiURL
	u.ttl = 0 // always refresh so each test call reflects the current server state
	return u
}

func TestUpdateCheckerAvailable(t *testing.T) {
	gh, _ := fakeGitHub(t, "v9.9.9", "https://example/releases/v9.9.9")
	info := newTestChecker("v0.1.0", true, gh.URL).info(context.Background())
	if !info.UpdateAvailable {
		t.Errorf("update_available = false, want true")
	}
	if info.Latest != "v9.9.9" || info.Current != "v0.1.0" {
		t.Errorf("got current=%q latest=%q", info.Current, info.Latest)
	}
	if info.HTMLURL == "" || info.Notes == "" || info.CheckedAt == "" {
		t.Errorf("missing display fields: %+v", info)
	}
	if info.Error != "" {
		t.Errorf("unexpected error: %q", info.Error)
	}
}

func TestUpdateCheckerUpToDate(t *testing.T) {
	gh, _ := fakeGitHub(t, "v0.1.0", "https://example/releases/v0.1.0")
	info := newTestChecker("v0.1.0", true, gh.URL).info(context.Background())
	if info.UpdateAvailable {
		t.Errorf("update_available = true, want false when running the latest")
	}
	if info.Latest != "v0.1.0" {
		t.Errorf("latest = %q, want v0.1.0", info.Latest)
	}
}

func TestUpdateCheckerDevBuild(t *testing.T) {
	gh, _ := fakeGitHub(t, "v0.1.0", "https://example/releases/v0.1.0")
	info := newTestChecker("dev", true, gh.URL).info(context.Background())
	if info.UpdateAvailable {
		t.Errorf("dev build must not report update_available")
	}
	if info.Latest != "v0.1.0" {
		t.Errorf("latest still reported for a dev build: %q", info.Latest)
	}
}

func TestUpdateCheckerDisabledMakesNoCall(t *testing.T) {
	gh, hits := fakeGitHub(t, "v9.9.9", "https://example/x")
	u := newUpdateChecker("v0.1.0", 0, false)
	u.apiURL = gh.URL
	info := u.info(context.Background())
	if !info.Disabled || info.Latest != "" {
		t.Errorf("disabled checker leaked a comparison: %+v", info)
	}
	if *hits != 0 {
		t.Errorf("disabled checker made %d outbound calls, want 0", *hits)
	}
	if info.Current != "v0.1.0" {
		t.Errorf("current = %q, want v0.1.0 even when disabled", info.Current)
	}
}

func TestUpdateCheckerErrorFallsBackToLastGood(t *testing.T) {
	// First a healthy endpoint, then a failing one — the last good comparison
	// must survive with the error annotated rather than blanking the banner.
	fail := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"tag_name": "v9.9.9", "html_url": "https://example/x"})
	}))
	defer srv.Close()

	u := newTestChecker("v0.1.0", true, srv.URL)
	if got := u.info(context.Background()); !got.UpdateAvailable {
		t.Fatalf("first check should see the update: %+v", got)
	}
	fail = true
	got := u.info(context.Background())
	if got.Latest != "v9.9.9" || !got.UpdateAvailable {
		t.Errorf("last-good comparison lost on error: %+v", got)
	}
	if got.Error == "" {
		t.Errorf("expected an error annotation after the endpoint failed")
	}
}

func TestUpdateCheckerCachesWithinTTL(t *testing.T) {
	gh, hits := fakeGitHub(t, "v9.9.9", "https://example/x")
	u := newUpdateChecker("v0.1.0", 0, true)
	u.apiURL = gh.URL
	u.ttl = time.Hour
	for i := 0; i < 3; i++ {
		u.info(context.Background())
	}
	if *hits != 1 {
		t.Errorf("made %d outbound calls, want 1 (cache should absorb polls)", *hits)
	}
}

func TestAdminVersionEndpoint(t *testing.T) {
	gh, _ := fakeGitHub(t, "v9.9.9", "https://example/releases/v9.9.9")
	cfg := testConfig()
	cfg.AdminToken = "s3cret"
	srv := &Server{cfg: cfg, metrics: newMetrics(), updates: newTestChecker("v0.1.0", true, gh.URL)}

	if rec := get(t, srv, "/admin/version", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token = %d, want 401", rec.Code)
	}

	rec := get(t, srv, "/admin/version", map[string]string{"Authorization": "Bearer s3cret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /admin/version = %d, want 200", rec.Code)
	}
	var info versionInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !info.UpdateAvailable || info.Latest != "v9.9.9" {
		t.Errorf("payload = %+v", info)
	}
}
