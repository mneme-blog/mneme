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

func TestAheadOfRelease(t *testing.T) {
	cases := []struct {
		current, latest string
		want            bool
	}{
		{"v0.2.1-6-g31eddf5", "v0.2.1", true},       // source build past the tag
		{"v0.2.1-1-g31eddf5-dirty", "v0.2.1", true}, // dirty tree, still past it
		{"v0.3.0", "v0.2.1", true},                  // tag newer than the newest release
		{"v0.3.0-2-gabcdef0", "v0.2.1", true},
		{"v0.2.1", "v0.2.1", false},            // exactly the release
		{"v0.2.0-6-g31eddf5", "v0.2.1", false}, // past an OLDER tag → a real update
		{"v0.2.0", "v0.2.1", false},
		{"main-31eddf5", "v0.2.1", false}, // image tag names no base → unknowable
		{"dev", "v0.2.1", false},
		{"", "v0.2.1", false},
		{"v0.2.1-6-g31eddf5", "nightly", false}, // unparseable release → no claim
		{"v0.2.1-rc1", "v0.2.1", false},         // prerelease of the release itself
	}
	for _, c := range cases {
		if got := aheadOfRelease(c.current, c.latest); got != c.want {
			t.Errorf("aheadOfRelease(%q, %q) = %v, want %v", c.current, c.latest, got, c.want)
		}
	}
}

func TestUpdateCheckerAheadOfLatest(t *testing.T) {
	gh, _ := fakeGitHub(t, "v0.2.1", "https://example/releases/v0.2.1", "")
	info := newTestChecker("v0.2.1-6-g31eddf5", true, gh.URL).info(context.Background())
	if info.UpdateAvailable {
		t.Errorf("a build past the tag must not report update_available")
	}
	if !info.AheadOfLatest {
		t.Errorf("ahead_of_latest = false, want true for %q vs v0.2.1", info.Current)
	}

	// The behind case keeps reporting a plain update, never "ahead".
	info = newTestChecker("v0.2.0-3-g31eddf5", true, gh.URL).info(context.Background())
	if !info.UpdateAvailable || info.AheadOfLatest {
		t.Errorf("behind the release: update=%v ahead=%v, want true/false", info.UpdateAvailable, info.AheadOfLatest)
	}
}

// ghHits counts requests per fake endpoint.
type ghHits struct{ releases, main int }

// fakeGitHub serves canned releases/latest and commits/main payloads and counts
// hits. An empty mainSha makes the commit endpoint 404 (main track unavailable).
func fakeGitHub(t *testing.T, tag, htmlURL, mainSha string) (*httptest.Server, *ghHits) {
	t.Helper()
	hits := &ghHits{}
	mux := http.NewServeMux()
	mux.HandleFunc("/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		hits.releases++
		_ = json.NewEncoder(w).Encode(map[string]string{
			"tag_name": tag, "html_url": htmlURL, "name": tag, "body": "release notes",
		})
	})
	mux.HandleFunc("/commits/main", func(w http.ResponseWriter, r *http.Request) {
		hits.main++
		if mainSha == "" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"sha":      mainSha,
			"html_url": "https://example/commit/" + mainSha,
			"commit":   map[string]any{"committer": map[string]string{"date": "2026-08-01T00:00:00Z"}},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, hits
}

// newTestChecker points BOTH outbound URLs at the fake — a checker in tests must
// never reach the real api.github.com.
func newTestChecker(current string, enabled bool, baseURL string) *updateChecker {
	u := newUpdateChecker(current, 0, enabled)
	u.apiURL = baseURL + "/releases/latest"
	u.mainAPIURL = baseURL + "/commits/main"
	u.ttl = 0 // always refresh so each test call reflects the current server state
	return u
}

func TestUpdateCheckerAvailable(t *testing.T) {
	gh, _ := fakeGitHub(t, "v9.9.9", "https://example/releases/v9.9.9", "")
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
	gh, _ := fakeGitHub(t, "v0.1.0", "https://example/releases/v0.1.0", "")
	info := newTestChecker("v0.1.0", true, gh.URL).info(context.Background())
	if info.UpdateAvailable {
		t.Errorf("update_available = true, want false when running the latest")
	}
	if info.Latest != "v0.1.0" {
		t.Errorf("latest = %q, want v0.1.0", info.Latest)
	}
}

func TestUpdateCheckerDevBuild(t *testing.T) {
	gh, _ := fakeGitHub(t, "v0.1.0", "https://example/releases/v0.1.0", "")
	info := newTestChecker("dev", true, gh.URL).info(context.Background())
	if info.UpdateAvailable {
		t.Errorf("dev build must not report update_available")
	}
	if info.Latest != "v0.1.0" {
		t.Errorf("latest still reported for a dev build: %q", info.Latest)
	}
}

func TestUpdateCheckerDisabledMakesNoCall(t *testing.T) {
	gh, hits := fakeGitHub(t, "v9.9.9", "https://example/x", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	u := newTestChecker("v0.1.0", false, gh.URL)
	info := u.info(context.Background())
	if !info.Disabled || info.Latest != "" || info.MainTag != "" {
		t.Errorf("disabled checker leaked a comparison: %+v", info)
	}
	if hits.releases+hits.main != 0 {
		t.Errorf("disabled checker made %d outbound calls, want 0", hits.releases+hits.main)
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
	gh, hits := fakeGitHub(t, "v9.9.9", "https://example/x", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	u := newTestChecker("v0.1.0", true, gh.URL)
	u.ttl = time.Hour
	for i := 0; i < 3; i++ {
		u.info(context.Background())
	}
	if hits.releases != 1 || hits.main != 1 {
		t.Errorf("made %d+%d outbound calls, want 1+1 (cache should absorb polls)", hits.releases, hits.main)
	}
}

func TestBuildMatchesCommit(t *testing.T) {
	const head = "44569a4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cases := []struct {
		current string
		want    bool
	}{
		{"main-44569a4", true},            // CI main build of the head
		{"main-" + head, true},            // full-sha form
		{"v0.2.1-3-g44569a4", true},       // source build of the head (git describe)
		{"v0.2.1-3-g44569a4-dirty", true}, // dirty working tree, same commit
		{"main-1234567", false},           // an older main build
		{"v0.2.1-3-g1234567", false},      // a source build of another commit
		{"v0.2.1", false},                 // release tag names no commit → no match
		{"dev", false},                    // unidentifiable build
		{"", false},
	}
	for _, c := range cases {
		if got := buildMatchesCommit(c.current, head); got != c.want {
			t.Errorf("buildMatchesCommit(%q, head) = %v, want %v", c.current, got, c.want)
		}
	}
}

func TestUpdateCheckerMainTrack(t *testing.T) {
	const head = "44569a4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	gh, _ := fakeGitHub(t, "v0.2.1", "https://example/releases/v0.2.1", head)

	// A release build names no commit → switching to main is offered.
	info := newTestChecker("v0.2.1", true, gh.URL).info(context.Background())
	if info.MainTag != "main-44569a4" || !info.MainUpdateAvailable {
		t.Errorf("release build: main_tag=%q available=%v, want main-44569a4/true", info.MainTag, info.MainUpdateAvailable)
	}
	if info.MainHTMLURL == "" || info.MainCommittedAt == "" {
		t.Errorf("missing main display fields: %+v", info)
	}

	// Builds of exactly the head commit are already on main — no switch offered.
	for _, current := range []string{"main-44569a4", "v0.2.1-3-g44569a4"} {
		info = newTestChecker(current, true, gh.URL).info(context.Background())
		if info.MainUpdateAvailable {
			t.Errorf("%q is the head of main but main_update_available = true", current)
		}
		if info.MainTag != "main-44569a4" {
			t.Errorf("%q: main_tag = %q, want main-44569a4", current, info.MainTag)
		}
	}

	// An older main build gets the switch offered again.
	info = newTestChecker("main-1234567", true, gh.URL).info(context.Background())
	if !info.MainUpdateAvailable {
		t.Errorf("older main build must offer the switch to the head")
	}
}

func TestUpdateCheckerMainHeadUnavailable(t *testing.T) {
	gh, _ := fakeGitHub(t, "v9.9.9", "https://example/x", "") // commits/main 404s
	info := newTestChecker("v0.1.0", true, gh.URL).info(context.Background())
	if info.MainTag != "" || info.MainUpdateAvailable {
		t.Errorf("main fields must stay empty when the head cannot be fetched: %+v", info)
	}
	if !info.UpdateAvailable || info.Latest != "v9.9.9" {
		t.Errorf("release comparison must survive a failed main fetch: %+v", info)
	}
}

func TestAdminVersionEndpoint(t *testing.T) {
	gh, _ := fakeGitHub(t, "v9.9.9", "https://example/releases/v9.9.9", "")
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
