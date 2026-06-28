//go:build integration

package workflow_test

import (
	"context"
	"encoding/json"
	"flag"
	"path/filepath"
	"testing"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/internal/golden"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// update regenerates golden files: go test -tags integration ./pkg/workflow -run Golden -update
var update = flag.Bool("update", false, "regenerate golden files")

// TestWorkflowDecodeGolden pins the JSON the dashboard emits for a running
// workflow instance decoded from seeded durabletask proto state. The seeded
// timestamp is fixed so the golden output is deterministic.
func TestWorkflowDecodeGolden(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "wf.db")
	store, err := statestore.New(context.Background(), statestore.Component{
		Name:    "statestore",
		Type:    "state.sqlite",
		Version: "v1",
		Metadata: map[string]string{
			"connectionString": dbPath,
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	ts := timestamppb.New(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	started := &protos.HistoryEvent{
		EventId:   0,
		Timestamp: ts,
		EventType: &protos.HistoryEvent_ExecutionStarted{
			ExecutionStarted: &protos.ExecutionStartedEvent{
				Name:  "OrderWorkflow",
				Input: &wrapperspb.StringValue{Value: `{"id":1}`},
			},
		},
	}
	b, err := proto.Marshal(started)
	require.NoError(t, err)

	prefix := statestore.InstancePrefix("default", "order", "inst-1")
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.SuffixMetadata, []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.HistoryPrefix+"000000", b))

	svc := workflow.New(store, "default", func(context.Context) ([]string, error) {
		return []string{"order"}, nil
	})
	ex, err := svc.Get(context.Background(), "order", "inst-1")
	require.NoError(t, err)

	got, err := json.MarshalIndent(ex, "", "  ")
	require.NoError(t, err)

	golden.Assert(t, *update, filepath.Join("testdata", "golden", "execution_running.golden.json"), got)
}
