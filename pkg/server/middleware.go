package server

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// localhostGuard hardens the loopback-only server against browser-borne
// attacks:
//
//   - DNS rebinding: every request must carry a loopback Host header
//     (localhost, 127.0.0.1, or ::1 — with or without a port). A rebinding
//     attack resolves an attacker-controlled name to 127.0.0.1, so the Host
//     header still names the attacker's domain and is rejected here.
//   - CSRF: state-changing requests (POST/PUT/DELETE/PATCH) with an Origin
//     header must originate from a loopback origin on any port (the Vite dev
//     server runs on its own port). Requests without an Origin header (curl,
//     CLI tools) are allowed.
func localhostGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackHostname(stripPort(r.Host)) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: non-local Host header"})
			return
		}
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
			if origin := r.Header.Get("Origin"); origin != "" && !isLoopbackOrigin(origin) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: cross-origin request"})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// stripPort returns the host part of a Host header value, which may or may
// not include a port (e.g. "localhost", "127.0.0.1:9090", "[::1]:8080").
func stripPort(hostport string) string {
	if host, _, err := net.SplitHostPort(hostport); err == nil {
		return host
	}
	// No port present; unbracket a bare IPv6 literal like "[::1]".
	return strings.TrimSuffix(strings.TrimPrefix(hostport, "["), "]")
}

// isLoopbackHostname reports whether host (no port, no brackets) is one of
// the names the dashboard is reachable under when bound to 127.0.0.1.
func isLoopbackHostname(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// isLoopbackOrigin reports whether an Origin header value points at a
// loopback host on any port.
func isLoopbackOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return isLoopbackHostname(u.Hostname())
}
