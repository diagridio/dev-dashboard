//go:build integration

package cmd

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// wiringFakeApps is a discovery.Service double returning fixed instances.
type wiringFakeApps struct {
	insts []discovery.Instance
}

func (f wiringFakeApps) List(context.Context) ([]discovery.Instance, error) {
	return f.insts, nil
}

func (f wiringFakeApps) Get(_ context.Context, appID string) (discovery.Instance, error) {
	for _, i := range f.insts {
		if i.AppID == appID {
			return i, nil
		}
	}
	return discovery.Instance{}, discovery.ErrNotFound
}

func httpGet(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	res, err := http.Get(url)
	require.NoError(t, err)
	b, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	return res, string(b)
}

// TestAssembleServerServesSeededWorkflow wires the real server via
// assembleOptions against a temp SQLite store seeded with one workflow
// instance, then drives the real HTTP surface end to end.
func TestAssembleServerServesSeededWorkflow(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "wf.db")

	// Seed one workflow instance into the SQLite store.
	store, err := statestore.New(context.Background(), statestore.Component{
		Name:    "statestore",
		Type:    "state.sqlite",
		Version: "v1",
		Metadata: map[string]string{
			"connectionString": dbPath,
		},
	})
	require.NoError(t, err)
	ts := timestamppb.New(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	started := &protos.HistoryEvent{
		EventId:   0,
		Timestamp: ts,
		EventType: &protos.HistoryEvent_ExecutionStarted{
			ExecutionStarted: &protos.ExecutionStartedEvent{
				Name:  "OrderWorkflow",
				Input: &wrapperspb.StringValue{Value: `{}`},
			},
		},
	}
	b, err := proto.Marshal(started)
	require.NoError(t, err)
	prefix := statestore.InstancePrefix("default", "order", "inst-1")
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.SuffixMetadata, []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.HistoryPrefix+"000000", b))
	require.NoError(t, store.Close())

	// Write a component YAML pointing at that DB.
	comp := "apiVersion: dapr.io/v1alpha1\n" +
		"kind: Component\n" +
		"metadata:\n  name: statestore\n" +
		"spec:\n  type: state.sqlite\n  version: v1\n  metadata:\n" +
		"  - name: connectionString\n    value: " + dbPath + "\n"
	compPath := filepath.Join(dir, "statestore.yaml")
	require.NoError(t, os.WriteFile(compPath, []byte(comp), 0o644))

	dist := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")},
	}

	opts, closers := assembleOptions(context.Background(), serveDeps{
		StateStorePath: compPath,
		Namespace:      "default",
		Apps: wiringFakeApps{insts: []discovery.Instance{
			{AppID: "order", HTTPPort: 3500, Health: discovery.HealthHealthy},
		}},
		HomeDir:    dir,
		HTTPClient: &http.Client{Timeout: 2 * time.Second},
	}, dist)
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	srv := httptest.NewServer(server.NewRouter(opts))
	t.Cleanup(srv.Close)

	// /api/health
	res, _ := httpGet(t, srv.URL+"/api/health")
	require.Equal(t, http.StatusOK, res.StatusCode)

	// /api/version returns JSON, 200.
	res, _ = httpGet(t, srv.URL+"/api/version")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "application/json", res.Header.Get("Content-Type"))

	// /api/apps reflects the fake app.
	res, body := httpGet(t, srv.URL+"/api/apps")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"order"`)

	// /api/workflows returns the seeded instance through the real read path.
	res, body = httpGet(t, srv.URL+"/api/workflows")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"inst-1"`)

	// Unknown non-/api route falls back to the SPA index.
	res, body = httpGet(t, srv.URL+"/some/spa/route")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "spa")
}
