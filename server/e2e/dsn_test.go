//go:build e2e

package e2e

import (
	"net/url"
	"os"
	"strings"
	"testing"
)

// testDSN gates every e2e test on TEST_DATABASE_URL — and on it naming a
// database that is clearly disposable. TestBackupRestoreRoundTrip TRUNCATEs
// every table it finds, and the old documented invocation pointed straight at
// the dev compose database: running the suite silently wiped local dev data.
// Either name the database with a "test" in it, or opt in explicitly with
// E2E_ALLOW_WIPE=1 (what CI does — its Postgres is an ephemeral container).
func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run e2e")
	}
	if os.Getenv("E2E_ALLOW_WIPE") == "1" {
		return dsn
	}
	name := ""
	if u, err := url.Parse(dsn); err == nil {
		name = strings.TrimPrefix(u.Path, "/")
	}
	if !strings.Contains(strings.ToLower(name), "test") {
		t.Fatalf("refusing to run destructive e2e against database %q — "+
			"the suite truncates ALL data. Point TEST_DATABASE_URL at a dedicated "+
			"test database (name containing \"test\"), or set E2E_ALLOW_WIPE=1.", name)
	}
	return dsn
}
