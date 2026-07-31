package api

import (
	"net/http"
	"strings"
)

// cors wraps the handler with by-config CORS and answers preflight OPTIONS.
//
// THE INVARIANT: never reflect an arbitrary origin while also sending
// Access-Control-Allow-Credentials. Reflecting is safe here only because auth
// is a Bearer header and no cookie is ever set, so a cross-origin page gets a
// response it cannot read and cannot authenticate. The day anything adds
// cookies or `Allow-Credentials`, `CORS_ORIGINS="*"` becomes an
// account-takeover bug — so if you add credentials, you must also drop the
// reflect-any mode, not just "configure it properly in production".
//
// Configure allowed origins via CORS_ORIGINS. "*" reflects any origin and is
// the dev default; production images (docker-compose.prod.yml) set an explicit
// allowlist instead, and the relay logs a warning at startup when it is left
// wide open — see config.CORSOrigins.
func (s *Server) cors(next http.Handler) http.Handler {
	allowAny := strings.TrimSpace(s.cfg.CORSOrigins) == "*"
	allowed := map[string]bool{}
	if !allowAny {
		for _, o := range strings.Split(s.cfg.CORSOrigins, ",") {
			if o = strings.TrimSpace(o); o != "" {
				allowed[o] = true
			}
		}
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (allowAny || allowed[origin]) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
