package server

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// requestGuard hardens the server against browser-borne attacks. Two modes:
//
// allowAnyHost=false (loopback bind, the host-mode default):
//   - DNS rebinding: every request must carry a loopback Host header.
//   - CSRF: mutating requests with an Origin header must originate from a
//     loopback origin on any port (the Vite dev server has its own port).
//
// allowAnyHost=true (aspire/container mode, reached through a proxy on an
// arbitrary host): the Host allowlist is meaningless, so it is skipped, and
// CSRF tightens to same-origin — a present Origin must match the request
// Host exactly. Requests without an Origin (curl, CLI tools) pass in both
// modes.
func requestGuard(allowAnyHost bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !allowAnyHost && !isLoopbackHostname(stripPort(r.Host)) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: non-local Host header"})
				return
			}
			switch r.Method {
			case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
				origin := r.Header.Get("Origin")
				if origin != "" {
					crossOrigin := !isLoopbackOrigin(origin)
					if allowAnyHost {
						crossOrigin = !sameOrigin(origin, r.Host)
					}
					if crossOrigin {
						writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: cross-origin request"})
						return
					}
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// sameOrigin reports whether an Origin header's host:port equals the
// request's Host header.
func sameOrigin(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return u.Host == host
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
