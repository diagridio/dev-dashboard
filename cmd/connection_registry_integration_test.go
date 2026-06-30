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

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"sigs.k8s.io/yaml"
)

// seedWorkflowInstance writes one workflow instance into a sqlite store at dbPath.
func seedWorkflowInstance(t *testing.T, dbPath, namespace, appID, instanceID, wfName string) {
	t.Helper()
	store, err := statestore.New(context.Background(), statestore.Component{
		Name: "seed", Type: "state.sqlite", Version: "v1",
		Metadata: map[string]string{"connectionString": dbPath},
	})
	require.NoError(t, err)
	ts := timestamppb.New(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	started := &protos.HistoryEvent{
		EventId:   0,
		Timestamp: ts,
		EventType: &protos.HistoryEvent_ExecutionStarted{
			ExecutionStarted: &protos.ExecutionStartedEvent{
				Name:  wfName,
				Input: &wrapperspb.StringValue{Value: `{}`},
			},
		},
	}
	b, err := proto.Marshal(started)
	require.NoError(t, err)
	prefix := statestore.InstancePrefix(namespace, appID, instanceID)
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.SuffixMetadata, []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.HistoryPrefix+"000000", b))
	require.NoError(t, store.Close())
}

// TestConnectionRegistry_AutoAndManualThroughLazyPool wires the real server with
// an auto-detected SQLite store A (active) and a pre-seeded registry file holding
// a manual SQLite store B. It asserts the list endpoint reports both with correct
// source/active, that B's workflows load lazily via ?store=<B's id>, and that the no-store
// default view returns A's instance.
func TestConnectionRegistry_AutoAndManualThroughLazyPool(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	// Store A: auto-detected from a component YAML, seeded with instance A1.
	dbA := filepath.Join(dir, "a.db")
	seedWorkflowInstance(t, dbA, "default", "order", "inst-A", "OrderWorkflow")
	compA := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: storeA\n" +
		"spec:\n  type: state.sqlite\n  version: v1\n  metadata:\n" +
		"  - name: connectionString\n    value: " + dbA + "\n"
	compPathA := filepath.Join(dir, "storeA.yaml")
	require.NoError(t, os.WriteFile(compPathA, []byte(compA), 0o644))

	// Store B: manual, seeded with instance B1, pre-written into the registry file.
	dbB := filepath.Join(dir, "b.db")
	seedWorkflowInstance(t, dbB, "default", "billing", "inst-B", "BillingWorkflow")
	regDir := filepath.Join(home, ".dapr", "dev-dashboard")
	require.NoError(t, os.MkdirAll(regDir, 0o700))
	regDoc := map[string]any{
		"connections": []map[string]any{
			{
				"name": "storeB", "type": "state.sqlite", "source": "manual",
				"metadata": map[string]string{"connectionString": dbB},
			},
		},
	}
	regYAML, err := yaml.Marshal(regDoc)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(regDir, "connections.yaml"), regYAML, 0o600))

	dist := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")}}

	opts, closers := assembleOptions(context.Background(), serveDeps{
		StateStorePath: compPathA,
		Namespace:      "default",
		Apps: wiringFakeApps{insts: []discovery.Instance{
			{AppID: "order", HTTPPort: 3500, Health: discovery.HealthHealthy},
		}},
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

	// GET /api/statestores lists BOTH stores with correct id + source + active.
	res, body := httpGet(t, srv.URL+"/api/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"name":"storeA"`)
	require.Contains(t, body, `"name":"storeB"`)
	require.Contains(t, body, `"source":"auto"`)
	require.Contains(t, body, `"source":"manual"`)
	// storeA is the elected active store.
	require.Regexp(t, `"name":"storeA"[^}]*"active":true`, body)

	// Read store B's stable id from the list response (rather than recomputing the
	// hash in the test) and address the store by that id.
	var stores []server.StoreInfo
	require.NoError(t, json.Unmarshal([]byte(body), &stores))
	var storeBID string
	for _, s := range stores {
		require.NotEmpty(t, s.ID, "every listed store carries an id")
		if s.Name == "storeB" {
			storeBID = s.ID
		}
	}
	require.NotEmpty(t, storeBID, "storeB must be listed with an id")

	// GET /api/workflows?store=<B's id> returns B's instance via the lazy pool.
	res, body = httpGet(t, srv.URL+"/api/workflows?store="+storeBID)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"inst-B"`)
	require.NotContains(t, body, `"instanceId":"inst-A"`, "store=B must not see store A's data")

	// GET /api/workflows (no store) returns the active store A's view.
	res, body = httpGet(t, srv.URL+"/api/workflows")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"inst-A"`)
	require.NotContains(t, body, `"instanceId":"inst-B"`, "the default view is store A only")
}
