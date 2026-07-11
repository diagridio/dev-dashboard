package discovery

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// sidecarBaseURL resolves the daprd HTTP endpoint: an explicit base URL
// (aspire contract) wins; otherwise the historical loopback-port form.
func sidecarBaseURL(base string, httpPort int) string {
	if base != "" {
		return strings.TrimRight(base, "/")
	}
	return fmt.Sprintf("http://127.0.0.1:%d", httpPort)
}

// CheckHealth probes a sidecar's /v1.0/healthz endpoint at baseURL.
func CheckHealth(ctx context.Context, client *http.Client, baseURL string) Health {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1.0/healthz", nil)
	if err != nil {
		return HealthUnknown
	}
	resp, err := client.Do(req)
	if err != nil {
		return HealthUnhealthy
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNoContent {
		return HealthHealthy
	}
	return HealthUnhealthy
}
