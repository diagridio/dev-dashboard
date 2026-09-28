//go:build integration

package workflow_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type metaFormat int

const (
	metaProto      metaFormat = iota // Dapr 1.16+: BackendWorkflowStateMetadata proto
	metaLegacyJSON                   // Dapr < 1.16: {"InboxLength","HistoryLength","Generation"}
	metaEmptyJSON                    // test fixtures: "{}" (forces the scan fallback)
)

// buildHistory returns n (>= 1) history events for synthetic instance i:
// ExecutionStarted, then TaskScheduled filler, then a terminal event chosen
// by i%4 (0 = still running, 1 = completed, 2 = failed, 3 = terminated).
// parent != "" marks the instance as a child of that instance id.
func buildHistory(i, n int, parent string) []*protos.HistoryEvent {
	base := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Minute)
	ts := func(k int) *timestamppb.Timestamp { return timestamppb.New(base.Add(time.Duration(k) * time.Second)) }

	started := &protos.ExecutionStartedEvent{Name: fmt.Sprintf("Workflow%d", i%5), Input: wrapperspb.String(`{}`)}
	if parent != "" {
		started.ParentInstance = &protos.ParentInstanceInfo{WorkflowInstance: &protos.WorkflowInstance{InstanceId: parent}}
	}
	h := []*protos.HistoryEvent{{EventId: -1, Timestamp: ts(0), EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: started}}}

	terminal := i%4 != 0
	fill := n - 1
	if terminal {
		fill = n - 2
	}
	for k := 0; k < fill; k++ {
		h = append(h, &protos.HistoryEvent{EventId: int32(k), Timestamp: ts(k + 1),
			EventType: &protos.HistoryEvent_TaskScheduled{TaskScheduled: &protos.TaskScheduledEvent{Name: "Activity"}}})
	}
	if terminal {
		ev := &protos.ExecutionCompletedEvent{}
		switch i % 4 {
		case 1:
			ev.WorkflowStatus = protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED
			ev.Result = wrapperspb.String(`"ok"`)
		case 2:
			ev.WorkflowStatus = protos.OrchestrationStatus_ORCHESTRATION_STATUS_FAILED
			ev.FailureDetails = &protos.TaskFailureDetails{ErrorType: "Boom", ErrorMessage: "failed on purpose"}
		case 3:
			ev.WorkflowStatus = protos.OrchestrationStatus_ORCHESTRATION_STATUS_TERMINATED
		}
		h = append(h, &protos.HistoryEvent{EventId: -1, Timestamp: ts(n),
			EventType: &protos.HistoryEvent_ExecutionCompleted{ExecutionCompleted: ev}})
	}
	return h
}

// seedInstance writes one instance's metadata, history-* and (optional)
// customStatus keys exactly as Dapr lays them out.
func seedInstance(tb testing.TB, store statestore.Store, ns, appID, id string, history []*protos.HistoryEvent, customStatus string, mf metaFormat) {
	tb.Helper()
	ctx := context.Background()
	prefix := statestore.InstancePrefix(ns, appID, id)

	var meta []byte
	switch mf {
	case metaProto:
		b, err := proto.Marshal(&protos.BackendWorkflowStateMetadata{HistoryLength: uint64(len(history)), Generation: 1})
		require.NoError(tb, err)
		meta = b
	case metaLegacyJSON:
		meta = []byte(fmt.Sprintf(`{"InboxLength":0,"HistoryLength":%d,"Generation":1}`, len(history)))
	case metaEmptyJSON:
		meta = []byte(`{}`)
	}
	require.NoError(tb, store.Set(ctx, prefix+statestore.SuffixMetadata, meta))
	for k, e := range history {
		b, err := proto.Marshal(e)
		require.NoError(tb, err)
		require.NoError(tb, store.Set(ctx, prefix+fmt.Sprintf("%s%06d", statestore.HistoryPrefix, k), b))
	}
	if customStatus != "" {
		require.NoError(tb, store.Set(ctx, prefix+statestore.SuffixCustomStatus, []byte(customStatus)))
	}
}

// seedMany seeds n instances in namespace "default", split across apps
// "order" (even i) and "billing" (odd i). The mix covers every load path:
//   - i == 0: 150 history events (spans several BulkGet chunks)
//   - i == 1: metadata "{}" (scan fallback)
//   - i%50 == 7: legacy JSON metadata
//   - i%10 == 3 (i > 3): child of instance i-1
//   - i%3 == 0: has a customStatus
//   - everything else: 5-30 events, proto metadata
func seedMany(tb testing.TB, store statestore.Store, n int) {
	tb.Helper()
	for i := 0; i < n; i++ {
		appID := "order"
		if i%2 == 1 {
			appID = "billing"
		}
		id := fmt.Sprintf("inst-%04d", i)
		events := 5 + i%26
		if i == 0 {
			events = 150
		}
		parent := ""
		if i%10 == 3 && i > 3 {
			parent = fmt.Sprintf("inst-%04d", i-1)
		}
		cs := ""
		if i%3 == 0 {
			cs = fmt.Sprintf(`{"step":%d}`, i)
		}
		mf := metaProto
		switch {
		case i == 1:
			mf = metaEmptyJSON
		case i%50 == 7:
			mf = metaLegacyJSON
		}
		seedInstance(tb, store, "default", appID, id, buildHistory(i, events, parent), cs, mf)
	}
}
