package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The update check is the relay's ONLY outbound call. It asks GitHub for the
// latest published release and compares its tag against the running build so
// the admin dashboard can surface a "newer version available" banner. The relay
// still never downloads or applies anything itself: when one-click updates are
// enabled, applying is the host agent's job (internal/deploy). Failures are
// non-fatal (the banner just stays hidden), and UPDATE_CHECK=off disables the
// call entirely for air-gapped deployments, preserving the dashboard's
// no-external-dependency property.

// releasesURL is the GitHub API endpoint for the newest release of this repo.
const releasesURL = "https://api.github.com/repos/plasticparticle/mneme/releases/latest"

// schemaAssetName is the release asset the release workflow attaches, describing
// the schema that release migrates to and how far back it can be rolled back.
// Reading it is what lets the dashboard warn *before* an update that this
// particular release cannot be undone by an image swap. Releases cut before this
// mechanism existed have no such asset; that is reported as "unknown", never
// assumed to be safe.
const schemaAssetName = "mneme-release.json"

// versionInfo is the /admin/version payload.
type versionInfo struct {
	Current         string `json:"current"`                // running build (main.version)
	Latest          string `json:"latest,omitempty"`       // newest release tag, when known
	UpdateAvailable bool   `json:"update_available"`       // latest is a higher semver than current
	HTMLURL         string `json:"html_url,omitempty"`     // release page to link to
	Name            string `json:"name,omitempty"`         // release name/title
	PublishedAt     string `json:"published_at,omitempty"` // release timestamp (RFC3339 from GitHub)
	Notes           string `json:"notes,omitempty"`        // truncated release body
	CheckedAt       string `json:"checked_at,omitempty"`   // when the relay last queried GitHub
	Disabled        bool   `json:"disabled,omitempty"`     // UPDATE_CHECK=off — no call made
	Error           string `json:"error,omitempty"`        // last check error, if any (non-fatal)

	// Schema is the migration head this build carries.
	Schema int `json:"schema"`
	// LatestSchema / LatestMinSafeSchema come from the newest release's
	// mneme-release.json asset; 0 when the release predates it or the fetch failed.
	LatestSchema        int `json:"latest_schema,omitempty"`
	LatestMinSafeSchema int `json:"latest_min_safe_schema,omitempty"`
	// RollbackAfterUpdate says what undoing this update would cost:
	//
	//	"fast"    — swap the image back; the schema is additive-compatible
	//	"deep"    — the release contains a breaking migration; undoing it means
	//	            rebuilding the database and replaying the pre-update backup
	//	"unknown" — the release published no schema manifest; assume the worst
	RollbackAfterUpdate string `json:"rollback_after_update,omitempty"`
}

// updateChecker fetches and caches the latest-release comparison. GitHub's
// unauthenticated rate limit is 60 requests/hour/IP and the dashboard polls, so
// results are cached for ttl and a failed check is cached too (don't hammer a
// down endpoint every poll — fall back to the last good comparison).
type updateChecker struct {
	current string
	schema  int // migration head compiled into this build
	enabled bool
	apiURL  string // overridable in tests
	client  *http.Client
	ttl     time.Duration

	mu        sync.Mutex
	cached    *versionInfo // last result served
	lastGood  *versionInfo // last successful fetch, kept as fallback on later errors
	checkedAt time.Time
}

func newUpdateChecker(current string, schema int, enabled bool) *updateChecker {
	return &updateChecker{
		current: current,
		schema:  schema,
		enabled: enabled,
		apiURL:  releasesURL,
		client:  &http.Client{Timeout: 5 * time.Second},
		ttl:     time.Hour,
	}
}

// info returns the current comparison, refreshing from GitHub when the cache is
// stale. Safe for concurrent callers.
func (u *updateChecker) info(ctx context.Context) versionInfo {
	if !u.enabled {
		return versionInfo{Current: u.current, Schema: u.schema, Disabled: true}
	}

	u.mu.Lock()
	defer u.mu.Unlock()

	if u.cached != nil && time.Since(u.checkedAt) < u.ttl {
		return *u.cached
	}

	res := u.fetch(ctx)
	u.checkedAt = time.Now()
	if res.Error == "" {
		good := res
		u.lastGood = &good
	} else if u.lastGood != nil {
		// Keep showing the last known-good comparison; annotate the failure.
		merged := *u.lastGood
		merged.Error = res.Error
		res = merged
	}
	res.CheckedAt = u.checkedAt.UTC().Format(time.RFC3339)

	stored := res
	u.cached = &stored
	return res
}

func (u *updateChecker) fetch(ctx context.Context) versionInfo {
	info := versionInfo{Current: u.current, Schema: u.schema}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.apiURL, nil)
	if err != nil {
		info.Error = "release check: " + err.Error()
		return info
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "mneme-relay")

	resp, err := u.client.Do(req)
	if err != nil {
		info.Error = "release check failed: " + err.Error()
		return info
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		info.Error = "release check: unexpected status " + resp.Status
		return info
	}

	var rel struct {
		TagName     string `json:"tag_name"`
		HTMLURL     string `json:"html_url"`
		Name        string `json:"name"`
		PublishedAt string `json:"published_at"`
		Body        string `json:"body"`
		Assets      []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel); err != nil {
		info.Error = "release check: bad response: " + err.Error()
		return info
	}

	info.Latest = rel.TagName
	info.HTMLURL = rel.HTMLURL
	info.Name = rel.Name
	info.PublishedAt = rel.PublishedAt
	info.Notes = truncateNotes(rel.Body)
	info.UpdateAvailable = semverLess(u.current, rel.TagName)

	for _, a := range rel.Assets {
		if a.Name == schemaAssetName {
			info.LatestSchema, info.LatestMinSafeSchema = u.fetchSchemaManifest(ctx, a.URL)
			break
		}
	}
	info.RollbackAfterUpdate = rollbackCost(u.schema, info.LatestSchema, info.LatestMinSafeSchema)
	return info
}

// fetchSchemaManifest reads a release's mneme-release.json asset. A failure here
// is deliberately silent: the manifest only sharpens a warning, and a missing one
// already degrades to "unknown", which warns harder rather than less.
func (u *updateChecker) fetchSchemaManifest(ctx context.Context, url string) (schema, minSafe int) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, 0
	}
	req.Header.Set("User-Agent", "mneme-relay")
	resp, err := u.client.Do(req)
	if err != nil {
		return 0, 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, 0
	}
	var m struct {
		Schema        int `json:"schema"`
		MinSafeSchema int `json:"min_safe_schema"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&m); err != nil {
		return 0, 0
	}
	return m.Schema, m.MinSafeSchema
}

// rollbackCost answers "if I take this update, what does undoing it cost?" —
// asked from the currently running build, before anything has changed.
//
// The target release declares the oldest schema head that can still run against
// its database (minSafe). Our own head is what we would be rolling back *to*. If
// ours is at least minSafe, the old binary tolerates the new schema and undoing
// the update is an image swap. Otherwise the schema moved in a way the old code
// cannot read, and the only way back is rebuild-and-restore.
func rollbackCost(currentSchema, targetSchema, targetMinSafe int) string {
	if targetSchema == 0 {
		return "unknown" // release published no manifest — do not assume it is safe
	}
	if currentSchema >= targetMinSafe {
		return "fast"
	}
	return "deep"
}

// semverLess reports whether a is an older release than b. Both must be valid
// vMAJOR.MINOR.PATCH tags; anything unparseable (e.g. a "dev" build) yields
// false, so development builds are never nagged.
func semverLess(a, b string) bool {
	av, aok := parseSemver(a)
	bv, bok := parseSemver(b)
	if !aok || !bok {
		return false
	}
	for i := 0; i < 3; i++ {
		if av[i] != bv[i] {
			return av[i] < bv[i]
		}
	}
	return false
}

// parseSemver reads a vMAJOR.MINOR.PATCH tag, ignoring any prerelease ("-...")
// or metadata ("+...") suffix. Returns ok=false on anything else.
func parseSemver(s string) ([3]int, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}

// truncateNotes bounds the release body shown in the banner (rune-safe).
func truncateNotes(s string) string {
	s = strings.TrimSpace(s)
	const max = 500
	r := []rune(s)
	if len(r) > max {
		return string(r[:max]) + "…"
	}
	return s
}

// GET /admin/version — running build vs. the latest GitHub release.
func (s *Server) handleAdminVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.updates.info(r.Context()))
}
