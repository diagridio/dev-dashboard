//go:build integration

package workflow_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// TestWorkflowListGetSQLite seeds one workflow instance into a temp SQLite
// database via statestore.SeedForTest and then asserts that:
//   - workflow.Service.List returns the instance with StatusRunning
//   - workflow.Service.Get returns a history slice of length 1
//
// SQLite is used instead of Redis because the SQLite backend stores values
// verbatim (binary values as base64, decoded on read), making it the
// reliable path for asserting proto round-trips.
//
// The connectionString is a plain file path; the components-contrib SQLite
// driver automatically prepends "file:" if the path does not already have it.
func TestWorkflowListGetSQLite(t *testing.T) {
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

	// Build a history event that drives StatusRunning when decoded.
	// An ExecutionStarted event with no corresponding ExecutionCompleted /
	// ExecutionFailed event means the orchestration is still running.
	started := &protos.HistoryEvent{
		EventId:   0,
		Timestamp: timestamppb.Now(),
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

	// Seed both state keys through the store write path so the SQLite
	// backend encodes them correctly (binary payload → base64 + is_binary=1).
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.SuffixMetadata, []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.HistoryPrefix+"000000", b))

	svc := workflow.New(store, "default")

	// List should return exactly one instance with StatusRunning.
	res, err := svc.List(context.Background(), workflow.ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, workflow.StatusRunning, res.Items[0].Status)
	require.Equal(t, "inst-1", res.Items[0].InstanceID)

	// Get should return the decoded history with one entry.
	ex, err := svc.Get(context.Background(), "order", "inst-1")
	require.NoError(t, err)
	require.Len(t, ex.History, 1)
}
