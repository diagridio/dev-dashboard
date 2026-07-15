//go:build e2e

package e2e_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestHarnessBootsDashboard proves the harness can build/locate the binary,
// boot it, and reach its HTTP surface — no external runtime required. It boots
// in dapr-run mode with no apps present; discovery simply returns an empty list.
func TestHarnessBootsDashboard(t *testing.T) {
	base := bootDashboard(t, "dapr-run", nil)

	_, status := getJSON(t, base, "/api/health")
	require.Equal(t, http.StatusOK, status)

	body, status := getJSON(t, base, "/api/version")
	require.Equal(t, http.StatusOK, status)
	require.Contains(t, body, "version")

	// Apps endpoint responds with valid JSON (an array), even when empty.
	body, status = getJSON(t, base, "/api/apps/")
	require.Equal(t, http.StatusOK, status)
	require.True(t, body == "[]" || body[0] == '[', "expected JSON array, got %q", body)
}
