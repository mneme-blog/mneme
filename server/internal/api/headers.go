package api

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"
)

// Security headers on the relay's OWN responses.
//
// apps/client/csp.js and the Caddyfile protect the client app. They do not
// protect this server: in the standard deployment the header block lives inside
// the SPA's file_server route, so /v1/*, /healthz and — the one that matters —
// /admin were answered with no CSP, no frame protection, no nosniff and no
// referrer policy. A relay run without a proxy at all had none of it either.
//
// That gap mattered most for the dashboard, which is a full HTML application
// that keeps ADMIN_TOKEN in sessionStorage and can approve owners, delete
// vaults, download every vault's ciphertext, restore an archive and restart the
// stack. Framable, it is a clickjacking target for the single-click controls
// (Approve / Reject / Back up now); without a CSP, any injection into it would
// run unconstrained with that token in reach.
//
// So the baseline is set here, by the origin server, where it holds regardless
// of what fronts it. A proxy that adds its own policy only intersects with this
// one — browsers enforce every policy they are given — which is the safe
// direction to drift.

// apiCSP is for everything that is not the dashboard: JSON, health probes,
// media chunks, backup archives. None of them may load or execute anything.
const apiCSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

// scriptTagRe finds inline <script> blocks so the dashboard's policy can name
// them by hash instead of allowing 'unsafe-inline'. The page has exactly one and
// carries no external script, which TestDashboardCSPCoversInlineScript pins.
var scriptTagRe = regexp.MustCompile(`(?s)<script(?:\s[^>]*)?>(.*?)</script>`)

// dashboardCSP is computed once from the bytes actually served, so it cannot
// drift from the page: editing dashboard.html changes the hash automatically.
var dashboardCSP = buildDashboardCSP(dashboardHTML)

// inlineScriptHashes returns the CSP source expressions for every inline script
// in page, in document order.
func inlineScriptHashes(page []byte) []string {
	var out []string
	for _, m := range scriptTagRe.FindAllSubmatch(page, -1) {
		sum := sha256.Sum256(m[1])
		out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	return out
}

// buildDashboardCSP writes the dashboard's policy.
//
//   - script-src is hashes only: no 'unsafe-inline', no external origin, so an
//     injected <script> cannot run even if one ever got into the markup.
//   - style-src keeps 'unsafe-inline': the page styles through a <style> block
//     and inline style attributes (the usage chart draws bars that way), and a
//     hash cannot cover attributes. This weakens CSS injection defence only.
//   - img-src allows data: for the inline favicon.
//   - connect-src 'self' matches the page's own fetches (it derives its API base
//     from location.pathname), so the token can never be posted elsewhere.
func buildDashboardCSP(page []byte) string {
	script := strings.Join(inlineScriptHashes(page), " ")
	if script == "" {
		// Unreachable while the page has an inline script (asserted by a test).
		// Fail safe rather than silently allowing inline execution.
		script = "'none'"
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src " + script,
		"style-src 'unsafe-inline'",
		"img-src 'self' data:",
		"connect-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	}, "; ")
}

// secureHeaders applies the baseline to every response. Handlers that need a
// different policy (the dashboard) overwrite Content-Security-Policy before they
// write, which is why this sets rather than appends.
func (s *Server) secureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", apiCSP)
		// A blob served with the wrong type must not be reinterpreted as script.
		h.Set("X-Content-Type-Options", "nosniff")
		// Belt-and-braces with frame-ancestors, for anything that predates it.
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
