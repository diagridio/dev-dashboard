//go:build unit

package discovery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestCheckHealthHealthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	require.Equal(t, HealthHealthy, CheckHealth(context.Background(), &http.Client{Timeout: time.Second}, port))
}

func TestCheckHealthUnhealthy(t *testing.T) {
	require.Equal(t, HealthUnhealthy, CheckHealth(context.Background(), &http.Client{Timeout: 100 * time.Millisecond}, 1)) // nothing listening on port 1
}
