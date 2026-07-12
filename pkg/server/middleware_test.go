//go:build unit

package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

// okHandler is the terminal handler used to observe that the guard let a
// request through.
var okHandler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
})

func guardedRequest(t *testing.T, method, host, origin string) *http.Response {
	t.Helper()
	req := httptest.NewRequest(method, "/api/health", nil)
	req.Host = host
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	requestGuard(guardConfig{})(okHandler).ServeHTTP(rec, req)
	return rec.Result()
}

func TestRequestGuardHost(t *testing.T) {
	tests := []struct {
		name string
		host string
		want int
	}{
		{"localhost without port", "localhost", http.StatusOK},
		{"localhost with port", "localhost:9090", http.StatusOK},
		{"loopback IPv4 without port", "127.0.0.1", http.StatusOK},
		{"loopback IPv4 with port", "127.0.0.1:8080", http.StatusOK},
		{"loopback IPv6 without port", "[::1]", http.StatusOK},
		{"loopback IPv6 with port", "[::1]:8080", http.StatusOK},
		{"uppercase localhost", "LOCALHOST:9090", http.StatusOK},
		{"evil host", "evil.example.com", http.StatusForbidden},
		{"evil host with port", "evil.example.com:9090", http.StatusForbidden},
		{"localhost subdomain of evil", "localhost.evil.example.com", http.StatusForbidden},
		{"loopback prefix of evil", "127.0.0.1.evil.example.com", http.StatusForbidden},
		{"empty host", "", http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := guardedRequest(t, http.MethodGet, tc.host, "")
			require.Equal(t, tc.want, res.StatusCode)
			if tc.want == http.StatusForbidden {
				require.Equal(t, "application/json", res.Header.Get("Content-Type"))
			}
		})
	}
}

func TestRequestGuardOrigin(t *testing.T) {
	tests := []struct {
		name   string
		method string
		origin string
		want   int
	}{
		{"POST without Origin (curl)", http.MethodPost, "", http.StatusOK},
		{"POST from Vite dev server", http.MethodPost, "http://localhost:5173", http.StatusOK},
		{"POST from same origin", http.MethodPost, "http://127.0.0.1:9090", http.StatusOK},
		{"POST from IPv6 loopback origin", http.MethodPost, "http://[::1]:9090", http.StatusOK},
		{"POST from evil origin", http.MethodPost, "https://evil.example.com", http.StatusForbidden},
		{"POST from evil origin with local-looking subdomain", http.MethodPost, "https://localhost.evil.example.com", http.StatusForbidden},
		{"POST with null origin", http.MethodPost, "null", http.StatusForbidden},
		{"PUT from evil origin", http.MethodPut, "https://evil.example.com", http.StatusForbidden},
		{"DELETE from evil origin", http.MethodDelete, "https://evil.example.com", http.StatusForbidden},
		{"PATCH from evil origin", http.MethodPatch, "https://evil.example.com", http.StatusForbidden},
		{"GET ignores Origin", http.MethodGet, "https://evil.example.com", http.StatusOK},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := guardedRequest(t, tc.method, "127.0.0.1:9090", tc.origin)
			require.Equal(t, tc.want, res.StatusCode)
		})
	}
}

// TestRouterAppliesRequestGuard proves the guard is wired into the full
// router, in front of the API and the SPA fallback.
func TestRouterAppliesRequestGuard(t *testing.T) {
	h := newTestRouter("")

	send := func(method, path, host, origin string) *http.Response {
		req := httptest.NewRequest(method, path, nil)
		req.Host = host
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Result()
	}

	// DNS rebinding: foreign Host is rejected on API and SPA routes alike.
	require.Equal(t, http.StatusForbidden, send(http.MethodGet, "/api/health", "evil.example.com", "").StatusCode)
	require.Equal(t, http.StatusForbidden, send(http.MethodGet, "/workflows", "evil.example.com", "").StatusCode)

	// CSRF: cross-site POST is rejected before routing.
	require.Equal(t, http.StatusForbidden, send(http.MethodPost, "/api/workflows/purge", "127.0.0.1:9090", "https://evil.example.com").StatusCode)

	// Legitimate local traffic still works.
	require.Equal(t, http.StatusOK, send(http.MethodGet, "/api/health", "127.0.0.1:9090", "").StatusCode)
	require.Equal(t, http.StatusOK, send(http.MethodGet, "/api/health", "[::1]:8080", "").StatusCode)
}

func TestRequestGuardAllowAnyHost(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	h := requestGuard(guardConfig{allowAnyHost: true})(ok)

	tests := []struct {
		name   string
		method string
		host   string
		origin string
		want   int
	}{
		{"non-loopback host allowed", http.MethodGet, "dashboard.example:8080", "", http.StatusOK},
		{"proxy host allowed", http.MethodGet, "diagrid-dashboard.localhost", "", http.StatusOK},
		{"mutating same-origin allowed", http.MethodPost, "dash.local:8080", "http://dash.local:8080", http.StatusOK},
		{"mutating no-origin allowed", http.MethodPost, "dash.local:8080", "", http.StatusOK},
		{"mutating cross-origin forbidden", http.MethodPost, "dash.local:8080", "http://evil.example", http.StatusForbidden},
		{"mutating origin port mismatch forbidden", http.MethodPost, "dash.local:8080", "http://dash.local:9999", http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/api/health", nil)
			req.Host = tc.host
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d", rec.Code, tc.want)
			}
		})
	}
}

func TestRequestGuardAllowedHosts(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	tests := []struct {
		name         string
		allowedHosts []string
		host         string
		want         int
	}{
		{"entry matches", []string{"dash.local"}, "dash.local", http.StatusOK},
		{"entry matches case-insensitive", []string{"dash.local"}, "DASH.LOCAL", http.StatusOK},
		{"entry matches ignoring port", []string{"dash.local"}, "dash.local:8080", http.StatusOK},
		{"non-listed host forbidden", []string{"dash.local"}, "evil.example", http.StatusForbidden},
		{"loopback always allowed", []string{"dash.local"}, "127.0.0.1:8080", http.StatusOK},
		{"localhost always allowed", []string{"dash.local"}, "localhost", http.StatusOK},
		{"empty list allows any host", nil, "anything.example:1234", http.StatusOK},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := requestGuard(guardConfig{allowAnyHost: true, allowedHosts: tc.allowedHosts})(ok)
			req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
			req.Host = tc.host
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d", rec.Code, tc.want)
			}
			if tc.want == http.StatusForbidden {
				require.Contains(t, rec.Body.String(), "Host not in allowed hosts")
			}
		})
	}
}

func TestRequestGuardNormalizedSameOrigin(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	tests := []struct {
		name   string
		origin string
		host   string
		port   int
		want   int
	}{
		{"portless http origin vs explicit port 80 host", "http://dash.local", "dash.local:80", 80, http.StatusOK},
		{"portless https origin vs portless host, cfg port 443", "https://dash.local", "dash.local", 443, http.StatusOK},
		{"case-insensitive hostname", "http://DASH.LOCAL", "dash.local:80", 80, http.StatusOK},
		{"effective port mismatch forbidden", "http://dash.local", "dash.local", 8080, http.StatusForbidden},
		{"unparsable origin forbidden", "http://[bad", "dash.local", 80, http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := requestGuard(guardConfig{allowAnyHost: true, port: tc.port})(ok)
			req := httptest.NewRequest(http.MethodPost, "/api/health", nil)
			req.Host = tc.host
			req.Header.Set("Origin", tc.origin)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d", rec.Code, tc.want)
			}
		})
	}
}
