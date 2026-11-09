//go:build e2e

package e2e_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestComposeDiscovery brings up a real compose project (redis + wfapp + daprd
// sidecar + placement), then boots the dashboard in compose mode and asserts it
// discovers the app, its component, and the completed workflow instance through
// the real HTTP API. The workflow assertion proves host->container Redis
// address translation.
//
// On Dapr 1.19+ it also enables the "dataref" compose profile (a second
// sidecar + datarefapp) and checks workflow data references end to end: see
// assertDataReference.
func TestComposeDiscovery(t *testing.T) {
	requireDocker(t)

	dataRef := daprRuntimeAtLeast(t, 1, 19)
	env := os.Environ()
	if dataRef {
		env = append(env, "COMPOSE_PROFILES=dataref")
	}

	dir := filepath.Join("fixtures", "compose")
	compose := func(args ...string) *exec.Cmd {
		c := exec.Command("docker", append([]string{"compose"}, args...)...)
		c.Dir = dir
		c.Env = env
		return c
	}

	// Register teardown before bringing the project up: if `up` partially
	// starts services and then errors, the require below aborts the test
	// immediately, and cleanup must still run to avoid leaking containers
	// and networks from the partial start.
	t.Cleanup(func() {
		down := compose("down", "-v")
		_, _ = down.CombinedOutput()
	})

	upCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	up := exec.CommandContext(upCtx, "docker", "compose", "up", "-d", "--build")
	up.Dir = dir
	up.Env = env
	out, err := up.CombinedOutput()
	require.NoErrorf(t, err, "compose up: %s", out)

	// Wait for wfapp to schedule and complete its workflow (marker line).
	var wfLogs string
	waitFor(t, 90*time.Second, func() bool {
		b, _ := compose("logs", "--no-log-prefix", "wfapp").CombinedOutput()
		wfLogs = string(b)
		return strings.Contains(wfLogs, "WORKFLOW_DONE")
	})
	var sdk string
	for _, line := range strings.Split(wfLogs, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "WFAPP_GO_SDK "); ok {
			sdk = v
		}
	}
	requireWfappSDK(t, sdk)

	base := bootDashboard(t, "compose", nil)

	// Apps: wfapp discovered from the compose sidecar.
	waitFor(t, 30*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/apps/")
		return strings.Contains(body, `"appId":"wfapp"`) &&
			strings.Contains(body, `"source":"compose"`)
	})
	body, _ := getJSON(t, base, "/api/apps/")
	require.Contains(t, body, `"health":"healthy"`)

	// Components: the actor state store read from the mounted -resources-path.
	body, _ = getJSON(t, base, "/api/resources/?kind=component")
	require.Contains(t, body, "e2ecomposestatestore")

	// Workflows: the completed instance is visible — proves host->container
	// Redis translation (redis:6379 -> localhost:<publishedPort>).
	waitFor(t, 30*time.Second, func() bool {
		body, status := getJSON(t, base, "/api/workflows/")
		return status == 200 && strings.Contains(body, "e2e-order-1")
	})

	t.Run("DataReference", func(t *testing.T) {
		if !dataRef {
			t.Skip("workflow data references need Dapr 1.19+ (set DAPR_RUNTIME_VERSION)")
		}
		assertDataReference(t, base, compose)
	})
}

// assertDataReference checks the Dapr 1.19 workflow data-reference path:
// datarefapp stored a payload in the "payloads" binary store and started a
// workflow whose input is the $daprRef envelope. The dashboard must show the
// envelope as the workflow input and serve the exact stored bytes through its
// binary store endpoint (sidecar gRPC GetBinaryFileAlpha1), including for a
// key containing slashes.
func assertDataReference(t *testing.T, base string, compose func(...string) *exec.Cmd) {
	var id, store, key, sha string
	var size int
	waitFor(t, 120*time.Second, func() bool {
		b, _ := compose("logs", "--no-log-prefix", "datarefapp").CombinedOutput()
		for _, line := range strings.Split(string(b), "\n") {
			if n, _ := fmt.Sscanf(line, "DATAREF_DONE %s %s %s %d %s", &id, &store, &key, &size, &sha); n == 5 {
				return true
			}
		}
		return false
	})
	require.True(t, strings.HasPrefix(key, "workflow-payloads/"+id+"/"), "key %q", key)

	// The workflow is listed and its input is the envelope, not the payload.
	waitFor(t, 30*time.Second, func() bool {
		body, status := getJSON(t, base, "/api/workflows/datarefapp/"+id)
		return status == 200 && strings.Contains(body, "$daprRef") && strings.Contains(body, sha)
	})

	file := func(k string, size int) (*http.Response, []byte) {
		u := fmt.Sprintf("%s/api/apps/datarefapp/binarystore/%s/file?key=%s&size=%d",
			base, url.PathEscape(store), url.QueryEscape(k), size)
		res, err := http.Get(u)
		require.NoError(t, err)
		defer func() { _ = res.Body.Close() }()
		b, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		return res, b
	}

	// The dashboard serves the exact stored bytes.
	var res *http.Response
	var got []byte
	waitFor(t, 30*time.Second, func() bool {
		res, got = file(key, size)
		return res.StatusCode == http.StatusOK
	})
	require.Equalf(t, http.StatusOK, res.StatusCode, "binary store read: %s", got)
	require.Equal(t, "application/octet-stream", res.Header.Get("Content-Type"))
	require.Len(t, got, size)
	sum := sha256.Sum256(got)
	require.Equal(t, sha, hex.EncodeToString(sum[:]), "payload hash must match the envelope")

	// A key that was never stored is a 404, not a 5xx.
	res, got = file("workflow-payloads/"+id+"/missing", 0)
	require.Equalf(t, http.StatusNotFound, res.StatusCode, "missing key: %s", got)
}
