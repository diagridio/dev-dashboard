//go:build integration

package cmd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestAssembleResolvesSecretKeyRefAndServesWorkflow(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "wf.db")

	// Seed one workflow instance into the SQLite store (inline connectionString).
	store, err := statestore.New(context.Background(), statestore.Component{
		Name: "statestore", Type: "state.sqlite", Version: "v1",
		Metadata: map[string]string{"connectionString": dbPath},
	})
	require.NoError(t, err)
	started := &protos.HistoryEvent{
		EventId:   0,
		Timestamp: timestamppb.New(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)),
		EventType: &protos.HistoryEvent_ExecutionStarted{
			ExecutionStarted: &protos.ExecutionStartedEvent{Name: "OrderWorkflow"},
		},
	}
	b, err := proto.Marshal(started)
	require.NoError(t, err)
	prefix := statestore.InstancePrefix("default", "order", "inst-1")
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.SuffixMetadata, []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.HistoryPrefix+"000000", b))
	require.NoError(t, store.Close())

	// secrets.json holds the connection string.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"),
		[]byte(`{"sqlite-secret":{"conn":"`+dbPath+`"}}`), 0o600))

	// local.file secret store component.
	secretComp := "apiVersion: dapr.io/v1alpha1\nkind: Component\n" +
		"metadata:\n  name: local-secrets\n" +
		"spec:\n  type: secretstores.local.file\n  version: v1\n  metadata:\n" +
		"  - name: secretsFile\n    value: secrets.json\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets-store.yaml"), []byte(secretComp), 0o644))

	// State-store component: connectionString via secretKeyRef.
	stateComp := "apiVersion: dapr.io/v1alpha1\nkind: Component\n" +
		"metadata:\n  name: statestore\n" +
		"spec:\n  type: state.sqlite\n  version: v1\n  metadata:\n" +
		"  - name: connectionString\n    secretKeyRef:\n      name: sqlite-secret\n      key: conn\n" +
		"auth:\n  secretStore: local-secrets\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(stateComp), 0o644))

	dist := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")}}

	// No StateStorePath override: the running app's ResourcePaths put `dir` in
	// scan scope so BOTH the state store and the secret store are detected.
	opts, closers := assembleOptions(context.Background(), serveDeps{
		Namespace: "default",
		Apps: wiringFakeApps{insts: []discovery.Instance{
			{AppID: "order", HTTPPort: 3500, Health: discovery.HealthHealthy, ResourcePaths: []string{dir}},
		}},
		HomeDir:    t.TempDir(), // empty: don't scan the real ~/.dapr
		HTTPClient: &http.Client{Timeout: 2 * time.Second},
	}, dist)
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	srv := httptest.NewServer(server.NewRouter(opts))
	t.Cleanup(srv.Close)

	// The secretKeyRef connectionString resolved → store connected → the seeded
	// instance is returned through the real read path.
	res, body := httpGet(t, srv.URL+"/api/workflows")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"inst-1"`)
}
