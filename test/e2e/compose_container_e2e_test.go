//go:build e2e

package e2e_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// containerProject is the compose project name for this test, distinct from
// TestComposeDiscovery's default project so the two never share containers.
const containerProject = "e2e-dash-container"

// TestComposeContainerPosture runs the dashboard image, built from this
// repository, as a service inside the real compose fixture (compose container
// posture): no Docker socket, apps declared through the DEVDASHBOARD_APP_*
// contract, sidecars addressed by compose service name. Unlike
// TestComposeDiscovery, which runs the binary on the host and reaches
// published ports, everything here goes over the compose network.
//
// Passes:
//  1. No store: apps, sidecar-gRPC workflows, capability gating, and (Dapr
//     1.19+) the workflow data-reference payload over the in-network sidecar.
//  2. Sidecar stopped, same dashboard (no store): workflow requests stay fast
//     and the detail is a 503 naming the app. The dashboard already holds a
//     gRPC channel to the sidecar — the case that used to wait out the full
//     per-call timeout while the channel reconnected to a vanished name.
//  3. Sidecar restarted, dashboard recreated with a store mounted: the store
//     is listed, the State API works, and workflow stats match the list (no
//     double count across sidecar and store).
//  4. Sidecar stopped again, same dashboard (store mounted): the app is
//     marked unreachable and its workflow detail falls back to the store.
func TestComposeContainerPosture(t *testing.T) {
	requireDocker(t)

	dataRef := daprRuntimeAtLeast(t, 1, 19)
	baseEnv := os.Environ()
	appCount := "1"
	if dataRef {
		baseEnv = append(baseEnv, "COMPOSE_PROFILES=dataref")
		appCount = "2"
	}
	baseEnv = append(baseEnv, "E2E_DASH_APP_COUNT="+appCount)

	dir := filepath.Join("fixtures", "compose")
	composeWith := func(extra []string, args ...string) *exec.Cmd {
		full := append([]string{"compose", "-p", containerProject, "-f", "docker-compose.yaml", "-f", "dashboard.yaml"}, args...)
		c := exec.Command("docker", full...)
		c.Dir = dir
		c.Env = append(append([]string{}, baseEnv...), extra...)
		return c
	}
	compose := func(args ...string) *exec.Cmd { return composeWith(nil, args...) }

	t.Cleanup(func() {
		if t.Failed() {
			out, _ := compose("logs", "--no-log-prefix", "dev-dashboard").CombinedOutput()
			t.Logf("dev-dashboard logs:\n%s", out)
		}
		_, _ = compose("down", "-v").CombinedOutput()
	})

	upCtx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	up := exec.CommandContext(upCtx, "docker", "compose", "-p", containerProject,
		"-f", "docker-compose.yaml", "-f", "dashboard.yaml", "up", "-d", "--build")
	up.Dir = dir
	up.Env = baseEnv
	out, err := up.CombinedOutput()
	require.NoErrorf(t, err, "compose up: %s", out)

	var wfLogs string
	waitFor(t, 90*time.Second, func() bool {
		b, _ := compose("logs", "--no-log-prefix", "wfapp").CombinedOutput()
		wfLogs = string(b)
		return strings.Contains(wfLogs, "WORKFLOW_DONE")
	})
	for _, line := range strings.Split(wfLogs, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "WFAPP_GO_SDK "); ok {
			requireWfappSDK(t, v)
		}
	}

	// recreate restarts only the dashboard container with the given store
	// setting and returns its (new) published base URL once it is healthy.
	recreate := func(t *testing.T, storeFile string) string {
		t.Helper()
		c := composeWith([]string{"E2E_DASH_STATESTORE_FILE=" + storeFile},
			"up", "-d", "--no-deps", "--force-recreate", "dev-dashboard")
		out, err := c.CombinedOutput()
		require.NoErrorf(t, err, "recreate dashboard: %s", out)
		return dashboardURL(t, compose)
	}

	base := dashboardURL(t, compose)

	// stopDaprd stops wfapp's sidecar. Compose removes a stopped container's
	// DNS name, so the dashboard's open gRPC channel can no longer resolve it.
	stopDaprd := func(t *testing.T) {
		t.Helper()
		out, err := compose("stop", "daprd").CombinedOutput()
		require.NoErrorf(t, err, "stop daprd: %s", out)
	}

	t.Run("NoStore", func(t *testing.T) {
		// Apps: discovered from the contract over the compose network.
		var app map[string]any
		waitFor(t, 60*time.Second, func() bool {
			body, status := getJSON(t, base, "/api/apps/wfapp")
			if status != http.StatusOK || json.Unmarshal([]byte(body), &app) != nil {
				return false
			}
			return app["health"] == "healthy"
		})
		require.Equal(t, "compose", app["source"])
		require.Equal(t, true, app["sidecarReachable"])
		require.Equal(t, "http://daprd:3500", app["daprHttpBaseUrl"])
		require.Equal(t, "daprd:50001", app["daprGrpcAddr"], "gRPC address derived from DAPR_HTTP")

		// Capabilities: container posture, workflows on without a store, the
		// runtime-dependent surfaces absent.
		index, status := getJSON(t, base, "/")
		require.Equal(t, http.StatusOK, status)
		require.Contains(t, index, `"containerPosture":true`)
		require.Contains(t, index, `"workflows":true`)
		require.Contains(t, index, `"state":false`)
		require.Contains(t, index, `"lifecycle":false`)
		for _, path := range []string{"/api/controlplane/", "/api/apps/wfapp/logs", "/api/state/"} {
			_, status := getJSON(t, base, path)
			require.Equalf(t, http.StatusNotFound, status, "%s must be unregistered", path)
		}
		body, _ := getJSON(t, base, "/api/statestores")
		require.JSONEq(t, `[]`, body)

		// Workflows: read live from the sidecar's gRPC API, no store.
		waitFor(t, 60*time.Second, func() bool {
			body, status := getJSON(t, base, "/api/workflows/")
			return status == http.StatusOK && strings.Contains(body, "e2e-order-1")
		})
		body, status = getJSON(t, base, "/api/workflows/wfapp/e2e-order-1")
		require.Equalf(t, http.StatusOK, status, "detail: %s", body)
		require.Contains(t, body, `"status":"Completed"`)

		// Components: from the mounted resources path.
		body, _ = getJSON(t, base, "/api/resources/?kind=component")
		require.Contains(t, body, "e2ecomposestatestore")

		t.Run("DataReference", func(t *testing.T) {
			if !dataRef {
				t.Skip("workflow data references need Dapr 1.19+ (set DAPR_RUNTIME_VERSION)")
			}
			assertDataReference(t, base, compose)
		})
	})

	t.Run("SidecarDownNoStore", func(t *testing.T) {
		stopDaprd(t)
		waitUnreachable(t, base, "wfapp")

		for _, path := range []string{"/api/workflows/", "/api/workflows/stats", "/api/workflows/appids"} {
			start := time.Now()
			_, status := getJSON(t, base, path)
			require.Equalf(t, http.StatusOK, status, "%s", path)
			require.Lessf(t, time.Since(start), 2*time.Second, "%s must not wait on the stopped sidecar", path)
		}
		body, status := getJSON(t, base, "/api/workflows/wfapp/e2e-order-1")
		require.Equalf(t, http.StatusServiceUnavailable, status, "detail: %s", body)
		require.Contains(t, body, `sidecar of app \"wfapp\" is unreachable`)
	})

	t.Run("StoreMounted", func(t *testing.T) {
		out, err := compose("start", "daprd").CombinedOutput()
		require.NoErrorf(t, err, "start daprd: %s", out)
		base = recreate(t, "/components/statestore.yaml")
		waitFor(t, 60*time.Second, func() bool {
			body, status := getJSON(t, base, "/api/apps/wfapp")
			return status == http.StatusOK && strings.Contains(body, `"sidecarReachable":true`) &&
				strings.Contains(body, `"health":"healthy"`)
		})

		// The configured store is listed read-only (no connection registry).
		waitFor(t, 60*time.Second, func() bool {
			_, _ = getJSON(t, base, "/api/apps/") // drives the reconcile
			body, _ := getJSON(t, base, "/api/statestores")
			return strings.Contains(body, "e2ecomposestatestore")
		})
		res, err := http.Post(base+"/api/statestores", "application/json",
			strings.NewReader(`{"name":"x","type":"state.redis","metadata":{"redisHost":"redis:6379"}}`))
		require.NoError(t, err)
		_ = res.Body.Close()
		require.Equal(t, http.StatusConflict, res.StatusCode, "connections can't be saved in container posture")

		// State API reaches the in-network store (no host address translation).
		body, status := getJSON(t, base, "/api/state/")
		require.Equalf(t, http.StatusOK, status, "state: %s", body)

		// Stats match the merged list: a workflow in both the sidecar and its
		// actor store is counted once.
		waitFor(t, 30*time.Second, func() bool {
			body, status := getJSON(t, base, "/api/workflows/")
			return status == http.StatusOK && strings.Contains(body, "e2e-order-1")
		})
		var list struct {
			Items []map[string]any `json:"items"`
		}
		body, _ = getJSON(t, base, "/api/workflows/")
		require.NoError(t, json.Unmarshal([]byte(body), &list))
		var stats struct {
			Total int `json:"total"`
		}
		body, _ = getJSON(t, base, "/api/workflows/stats")
		require.NoError(t, json.Unmarshal([]byte(body), &stats))
		require.Equal(t, len(list.Items), stats.Total, "stats must not double-count")
	})

	t.Run("SidecarDownStoreMounted", func(t *testing.T) {
		// Warm the sidecar channel on this dashboard before the sidecar goes.
		_, status := getJSON(t, base, "/api/workflows/wfapp/e2e-order-1")
		require.Equal(t, http.StatusOK, status)
		stopDaprd(t)
		waitUnreachable(t, base, "wfapp")

		// The detail falls back to the store the sidecar can't answer for.
		waitFor(t, 30*time.Second, func() bool {
			body, status := getJSON(t, base, "/api/workflows/wfapp/e2e-order-1")
			return status == http.StatusOK && strings.Contains(body, `"status":"Completed"`)
		})
	})
}

// dashboardURL resolves the dashboard service's published port and waits for
// it to answer /api/health.
func dashboardURL(t *testing.T, compose func(...string) *exec.Cmd) string {
	t.Helper()
	var base string
	waitFor(t, 60*time.Second, func() bool {
		out, err := compose("port", "dev-dashboard", "8080").Output()
		if err != nil {
			return false
		}
		hostPort := strings.TrimSpace(string(out))
		if i := strings.LastIndex(hostPort, ":"); i >= 0 {
			hostPort = hostPort[i+1:]
		}
		if hostPort == "" || hostPort == "0" {
			return false
		}
		base = fmt.Sprintf("http://127.0.0.1:%s", hostPort)
		res, err := http.Get(base + "/api/health")
		if err != nil {
			return false
		}
		_ = res.Body.Close()
		return res.StatusCode == http.StatusOK
	})
	return base
}

// waitUnreachable polls until discovery marks appID's sidecar unreachable.
func waitUnreachable(t *testing.T, base, appID string) {
	t.Helper()
	waitFor(t, 60*time.Second, func() bool {
		body, status := getJSON(t, base, "/api/apps/"+appID)
		var app map[string]any
		if status != http.StatusOK || json.Unmarshal([]byte(body), &app) != nil {
			return false
		}
		return app["sidecarReachable"] == false
	})
}
