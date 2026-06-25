package discovery

import (
	"context"
	"fmt"
	"net/http"
)

// CheckHealth probes a sidecar's /v1.0/healthz endpoint.
func CheckHealth(ctx context.Context, client *http.Client, httpPort int) Health {
	url := fmt.Sprintf("http://127.0.0.1:%d/v1.0/healthz", httpPort)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
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
