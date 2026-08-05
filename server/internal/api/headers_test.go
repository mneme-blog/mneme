package api

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/plasticparticle/mneme/server/internal/config"
)

// The dashboard's policy is generated from the page itself, which is only sound
// while the page keeps the shape the generator assumes: exactly one inline
// script and no external one. Adding a second <script> is fine (it gets its own
// hash); adding `src=` to one is not, and would silently stop it loading.
func TestDashboardCSPCoversInlineScript(t *testing.T) {
	page := string(dashboardHTML)

	blocks := scriptTagRe.FindAllStringSubmatch(page, -1)
	if len(blocks) != 1 {
		t.Fatalf("expected exactly one inline <script> in the dashboard, found %d", len(blocks))
	}
	if strings.Contains(strings.SplitN(page[strings.Index(page, "<script"):], ">", 2)[0], "src=") {
		t.Fatal("the dashboard's script tag has a src= — the CSP hash only covers inline code")
	}

	sum := sha256.Sum256([]byte(blocks[0][1]))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	if !strings.Contains(dashboardCSP, want) {
		t.Fatalf("dashboard CSP does not carry the inline script's hash %s:\n%s", want, dashboardCSP)
	}
	for _, must := range []string{"frame-ancestors 'none'", "connect-src 'self'", "object-src 'none'"} {
		if !strings.Contains(dashboardCSP, must) {
			t.Errorf("dashboard CSP is missing %q", must)
		}
	}
	for _, d := range strings.Split(dashboardCSP, "; ") {
		if strings.HasPrefix(d, "script-src ") && strings.Contains(d, "'unsafe-inline'") {
			t.Errorf("script-src must not allow 'unsafe-inline': %q", d)
		}
	}
}

// Every response carries the baseline, and the dashboard swaps in its own CSP.
func TestSecurityHeaders(t *testing.T) {
	s := New(nil, nil, config.Config{AdminToken: "t"})
	h := s.Routes()

	for _, tc := range []struct{ name, path, csp string }{
		{"health", "/healthz", apiCSP},
		{"dashboard", "/admin", dashboardCSP},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
			got := rec.Header()
			if got.Get("Content-Security-Policy") != tc.csp {
				t.Errorf("CSP = %q, want %q", got.Get("Content-Security-Policy"), tc.csp)
			}
			if got.Get("X-Frame-Options") != "DENY" {
				t.Errorf("X-Frame-Options = %q", got.Get("X-Frame-Options"))
			}
			if got.Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("X-Content-Type-Options = %q", got.Get("X-Content-Type-Options"))
			}
			if got.Get("Referrer-Policy") != "no-referrer" {
				t.Errorf("Referrer-Policy = %q", got.Get("Referrer-Policy"))
			}
		})
	}
}
