package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mneme-blog/mneme/server/internal/backup"
)

const testArchive = "mneme-backup-20260101T000000Z.tar.gz"

// backupServer builds a server whose backup directory holds one archive.
func backupServer(t *testing.T, token string) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, testArchive), []byte("not really a tarball"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig()
	cfg.AdminToken = token
	srv := New(nil, nil, cfg)
	srv.backup = backup.NewService(dir, 0, nil, nil)
	return srv, dir
}

func do(t *testing.T, srv *Server, method, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	srv.Routes().ServeHTTP(rec, req)
	return rec
}

// mint asks for a ticket and returns the relative URL the dashboard would follow.
func mint(t *testing.T, srv *Server, name string) string {
	t.Helper()
	rec := do(t, srv, http.MethodPost, "/admin/backups/"+name+"/ticket", "s3cret")
	if rec.Code != http.StatusOK {
		t.Fatalf("ticket request = %d, want 200", rec.Code)
	}
	var body struct{ Ticket, URL string }
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Ticket == "" || body.URL == "" {
		t.Fatalf("ticket response missing fields: %s", rec.Body.String())
	}
	return "/admin/" + body.URL
}

// The download the dashboard actually performs: a plain browser navigation with
// no Authorization header, authorized only by the ticket in the query string.
func TestBackupDownloadByTicket(t *testing.T) {
	srv, _ := backupServer(t, "s3cret")

	rec := do(t, srv, http.MethodGet, mint(t, srv, testArchive), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("ticketed download = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "not really a tarball" {
		t.Errorf("body = %q, want the archive bytes", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="`+testArchive+`"` {
		t.Errorf("Content-Disposition = %q", got)
	}
}

// A ticket is spent by the download it authorizes, so the URL left behind in the
// browser's history is inert.
func TestBackupTicketIsSingleUse(t *testing.T) {
	srv, _ := backupServer(t, "s3cret")
	u := mint(t, srv, testArchive)

	if rec := do(t, srv, http.MethodGet, u, ""); rec.Code != http.StatusOK {
		t.Fatalf("first download = %d, want 200", rec.Code)
	}
	if rec := do(t, srv, http.MethodGet, u, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("replayed ticket = %d, want 401", rec.Code)
	}
}

// A ticket names the one archive it may fetch: it cannot be pointed at another.
func TestBackupTicketIsBoundToItsArchive(t *testing.T) {
	srv, dir := backupServer(t, "s3cret")
	other := "mneme-backup-20260202T000000Z.tar.gz"
	if err := os.WriteFile(filepath.Join(dir, other), []byte("second archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Mint for the first archive, aim at the second.
	tk := mint(t, srv, testArchive)
	swapped := "/admin/backups/" + other + tk[len("/admin/backups/"+testArchive):]

	if rec := do(t, srv, http.MethodGet, swapped, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("ticket used on another archive = %d, want 401", rec.Code)
	}
}

func TestBackupTicketExpires(t *testing.T) {
	srv, _ := backupServer(t, "s3cret")
	srv.downloadTickets = newTicketStore(time.Nanosecond)
	u := mint(t, srv, testArchive)
	time.Sleep(time.Millisecond)

	if rec := do(t, srv, http.MethodGet, u, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("expired ticket = %d, want 401", rec.Code)
	}
}

// The documented header path (curl, scripts, the CLI) must keep working: opening
// the endpoint to tickets must not have closed it to the admin token.
func TestBackupDownloadByAdminToken(t *testing.T) {
	srv, _ := backupServer(t, "s3cret")

	if rec := do(t, srv, http.MethodGet, "/admin/backups/"+testArchive, "s3cret"); rec.Code != http.StatusOK {
		t.Fatalf("token download = %d, want 200", rec.Code)
	}
	if rec := do(t, srv, http.MethodGet, "/admin/backups/"+testArchive, "wrong"); rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong token = %d, want 401", rec.Code)
	}
	if rec := do(t, srv, http.MethodGet, "/admin/backups/"+testArchive, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("no credential = %d, want 401", rec.Code)
	}
}

// Losing adminAuth on the download route must not have made it visible on a
// relay with no ADMIN_TOKEN — every /admin path is a 404 there.
func TestBackupDownloadHiddenWithoutAdminToken(t *testing.T) {
	srv, _ := backupServer(t, "")

	if rec := do(t, srv, http.MethodGet, "/admin/backups/"+testArchive, ""); rec.Code != http.StatusNotFound {
		t.Errorf("download without ADMIN_TOKEN configured = %d, want 404", rec.Code)
	}
}

// A ticket for an archive that is not there is a 404 at minting time, so the
// dashboard reports it instead of starting a download that quietly fails.
func TestBackupTicketUnknownArchive(t *testing.T) {
	srv, _ := backupServer(t, "s3cret")

	rec := do(t, srv, http.MethodPost, "/admin/backups/mneme-backup-20990101T000000Z.tar.gz/ticket", "s3cret")
	if rec.Code != http.StatusNotFound {
		t.Errorf("ticket for a missing archive = %d, want 404", rec.Code)
	}
	rec = do(t, srv, http.MethodPost, "/admin/backups/..%2Fetc%2Fpasswd/ticket", "s3cret")
	if rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound {
		t.Errorf("ticket for a malformed name = %d, want 400 or 404", rec.Code)
	}
}
