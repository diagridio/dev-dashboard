package server

import (
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// guardConfig configures requestGuard.
type guardConfig struct {
	// allowAnyHost switches from the loopback allowlist to container posture.
	allowAnyHost bool
	// allowedHosts, when non-empty in container posture, restricts the Host
	// header to these hostnames (case-insensitive, port ignored); loopback
	// hostnames are always allowed. Defense against DNS rebinding.
	allowedHosts []string
	// port is the server's listen port, used to normalize a portless Host
	// header when comparing Origin against Host.
	port int
}

// requestGuard hardens the server against browser-borne attacks. Two postures:
//
// allowAnyHost=false (loopback bind, the host-mode default):
//   - DNS rebinding: every request must carry a loopback Host header.
//   - CSRF: mutating requests with an Origin header must originate from a
//     loopback origin on any port (the Vite dev server has its own port).
//
// allowAnyHost=true (aspire/container mode, reached through a proxy on an
// arbitrary host): the loopback Host check is dropped. When allowedHosts is
// non-empty, the Host header must be a loopback name or one of the allowlist
// entries (defense against DNS rebinding through a published localhost port).
// CSRF tightens to normalized same-origin — a present Origin must match the
// request Host on hostname and effective port. Requests without an Origin
// (curl, CLI tools) pass in both postures.
func requestGuard(cfg guardConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !cfg.allowAnyHost {
				if !isLoopbackHostname(stripPort(r.Host)) {
					writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: non-local Host header"})
					return
				}
			} else if len(cfg.allowedHosts) > 0 {
				host := stripPort(r.Host)
				if !isLoopbackHostname(host) && !hostInAllowlist(host, cfg.allowedHosts) {
					writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: Host not in allowed hosts"})
					return
				}
			}
			switch r.Method {
			case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
				origin := r.Header.Get("Origin")
				if origin != "" {
					var crossOrigin bool
					if cfg.allowAnyHost {
						crossOrigin = !normalizedSameOrigin(origin, r.Host, cfg.port)
					} else {
						crossOrigin = !isLoopbackOrigin(origin)
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

// hostInAllowlist reports whether host (no port, no brackets) matches one of
// the allowlist entries, case-insensitively.
func hostInAllowlist(host string, allowed []string) bool {
	for _, h := range allowed {
		if strings.EqualFold(host, h) {
			return true
		}
	}
	return false
}

// normalizedSameOrigin reports whether an Origin header shares hostname and
// effective port with the request Host. Effective ports: the Origin's explicit
// port, else 443 for https / 80 for http; the request Host's explicit port,
// else the server's listen port. Hostnames compare case-insensitively. An
// unparsable or host-less Origin is rejected.
func normalizedSameOrigin(origin, host string, port int) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	originPort := u.Port()
	if originPort == "" {
		if strings.EqualFold(u.Scheme, "https") {
			originPort = "443"
		} else {
			originPort = "80"
		}
	}
	hostPort := portOf(host)
	if hostPort == "" {
		hostPort = strconv.Itoa(port)
	}
	return strings.EqualFold(u.Hostname(), stripPort(host)) && originPort == hostPort
}

// portOf returns the explicit port of a Host header value, or "" if none.
func portOf(hostport string) string {
	if _, p, err := net.SplitHostPort(hostport); err == nil {
		return p
	}
	return ""
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
