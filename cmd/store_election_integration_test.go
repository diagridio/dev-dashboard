//go:build integration

package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/stretchr/testify/require"
)

func TestStoreElection_AppStoreWinsOverSameNamedGlobalDefault(t *testing.T) {
	home := t.TempDir()
	appDir := t.TempDir()

	// Two same-named state.redis components: global default vs the app's own.
	comp := func(host string) string {
		return "apiVersion: dapr.io/v1alpha1\nkind: Component\n" +
			"metadata:\n  name: statestore\n" +
			"spec:\n  type: state.redis\n  version: v1\n  metadata:\n" +
			"  - name: redisHost\n    value: " + host + "\n" +
			"  - name: actorStateStore\n    value: \"true\"\n"
	}
	defaultDir := filepath.Join(home, ".dapr", "components")
	require.NoError(t, os.MkdirAll(defaultDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(defaultDir, "statestore.yaml"), []byte(comp("localhost:6379")), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(appDir, "statestore.yaml"), []byte(comp("localhost:16379")), 0o644))

	dist := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")}}

	// The app loaded a component named "statestore" and its resources live in appDir.
	opts, closers := assembleOptions(context.Background(), serveDeps{
		Namespace: "default",
		Apps: wiringFakeApps{insts: []discovery.Instance{{
			AppID: "pr-digest", Health: discovery.HealthHealthy,
			ResourcePaths: []string{appDir},
			Components:    []discovery.Component{{Name: "statestore", Type: "state.redis"}},
		}}},
		HomeDir:    home,
		HTTPClient: &http.Client{Timeout: 2 * time.Second},
	}, dist)
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	srv := httptest.NewServer(server.NewRouter(opts))
	t.Cleanup(srv.Close)

	res, body := httpGet(t, srv.URL+"/api/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)

	var stores []server.StoreInfo
	require.NoError(t, json.Unmarshal([]byte(body), &stores))
	require.Len(t, stores, 2)

	var appStore, defaultStore *server.StoreInfo
	for i := range stores {
		switch stores[i].Connection {
		case "localhost:16379":
			appStore = &stores[i]
		case "localhost:6379":
			defaultStore = &stores[i]
		}
	}
	require.NotNil(t, appStore, "app store (16379) must be listed")
	require.NotNil(t, defaultStore, "global default (6379) must be listed")
	require.True(t, appStore.Active, "the app-provided store must be active")
	require.False(t, defaultStore.Active, "the same-named ~/.dapr default must not be active")
}
