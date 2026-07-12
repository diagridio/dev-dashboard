//go:build unit

package workflow

import (
	"context"
	"net"
	"strconv"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type fakeHub struct {
	protos.UnimplementedTaskHubSidecarServiceServer
	// pages served by ListInstanceIDs; the continuation token is the next
	// page index, so paging is stateless and every fresh query restarts at
	// page 0 (a mutable cursor would corrupt the second List call).
	pages         [][]string
	states        map[string]*protos.WorkflowState
	history       map[string][]*protos.HistoryEvent
	unimplemented bool
}

func (f *fakeHub) ListInstanceIDs(_ context.Context, req *protos.ListInstanceIDsRequest) (*protos.ListInstanceIDsResponse, error) {
	if f.unimplemented {
		return nil, status.Error(codes.Unimplemented, "not implemented")
	}
	page := 0
	if tok := req.GetContinuationToken(); tok != "" {
		page, _ = strconv.Atoi(tok)
	}
	if page >= len(f.pages) {
		return &protos.ListInstanceIDsResponse{}, nil
	}
	resp := &protos.ListInstanceIDsResponse{InstanceIds: f.pages[page]}
	if page < len(f.pages)-1 {
		tok := strconv.Itoa(page + 1)
		resp.ContinuationToken = &tok
	}
	return resp, nil
}

func (f *fakeHub) GetInstance(_ context.Context, req *protos.GetInstanceRequest) (*protos.GetInstanceResponse, error) {
	st, ok := f.states[req.GetInstanceId()]
	if !ok {
		return &protos.GetInstanceResponse{Exists: false}, nil
	}
	return &protos.GetInstanceResponse{Exists: true, WorkflowState: st}, nil
}

func (f *fakeHub) GetInstanceHistory(_ context.Context, req *protos.GetInstanceHistoryRequest) (*protos.GetInstanceHistoryResponse, error) {
	if f.unimplemented {
		return nil, status.Error(codes.Unimplemented, "not implemented")
	}
	return &protos.GetInstanceHistoryResponse{Events: f.history[req.GetInstanceId()]}, nil
}

// startFakeHub serves hub on a random loopback port and returns its address.
func startFakeHub(t *testing.T, hub *fakeHub) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	srv := grpc.NewServer()
	protos.RegisterTaskHubSidecarServiceServer(srv, hub)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return lis.Addr().String()
}

func wfState(id, name string, st protos.OrchestrationStatus, parent string) *protos.WorkflowState {
	s := &protos.WorkflowState{
		InstanceId:       id,
		Name:             name,
		WorkflowStatus:   st,
		CreatedTimestamp: timestamppb.Now(),
	}
	if parent != "" {
		s.ParentInstanceId = wrapperspb.String(parent)
	}
	return s
}

func fixedEndpoints(appID, addr string) EndpointsFunc {
	return func(context.Context) []SidecarEndpoint {
		return []SidecarEndpoint{{AppID: appID, Addr: addr}}
	}
}

func TestSidecarList_PagesAndFiltersChildren(t *testing.T) {
	hub := &fakeHub{
		pages: [][]string{{"parent-1"}, {"child-1"}},
		states: map[string]*protos.WorkflowState{
			"parent-1": wfState("parent-1", "ParentWorkflow", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, ""),
			"child-1":  wfState("child-1", "ChildWorkflow", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "parent-1"),
		},
	}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("workflow-patterns-app", addr))

	// Default view hides children.
	res, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "parent-1", res.Items[0].InstanceID)
	require.Equal(t, StatusCompleted, res.Items[0].Status)
	require.Equal(t, "workflow-patterns-app", res.Items[0].AppID)

	// IncludeChildren surfaces both (proves pagination followed the token).
	res, err = svc.List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 2)
	require.Empty(t, res.NextToken)
}

func TestSidecarStats_TalliesStatuses(t *testing.T) {
	hub := &fakeHub{
		pages: [][]string{{"a", "b"}},
		states: map[string]*protos.WorkflowState{
			"a": wfState("a", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, ""),
			"b": wfState("b", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_FAILED, ""),
		},
	}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("app", addr))

	stats, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Equal(t, 2, stats.Total)
	require.Equal(t, 1, stats.Counts[StatusCompleted])
	require.Equal(t, 1, stats.Counts[StatusFailed])
}

func TestSidecarGet_DecodesHistoryAndMapsNotFound(t *testing.T) {
	// Build a minimal real history: started + completed (see decode_test.go).
	events := []*protos.HistoryEvent{
		{
			EventId: -1, Timestamp: timestamppb.Now(),
			EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
				Name: "ParentWorkflow",
			}},
		},
		{
			EventId: -1, Timestamp: timestamppb.Now(),
			EventType: &protos.HistoryEvent_ExecutionCompleted{ExecutionCompleted: &protos.ExecutionCompletedEvent{
				WorkflowStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			}},
		},
	}
	hub := &fakeHub{
		pages:   [][]string{{"parent-1"}},
		states:  map[string]*protos.WorkflowState{"parent-1": wfState("parent-1", "ParentWorkflow", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "")},
		history: map[string][]*protos.HistoryEvent{"parent-1": events},
	}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("app", addr))

	ex, err := svc.Get(context.Background(), "app", "parent-1")
	require.NoError(t, err)
	require.Equal(t, "ParentWorkflow", ex.Name)
	require.Equal(t, StatusCompleted, ex.Status)
	require.NotEmpty(t, ex.History)

	_, err = svc.Get(context.Background(), "app", "missing")
	require.ErrorIs(t, err, ErrNotFound)

	_, err = svc.Get(context.Background(), "unknown-app", "parent-1")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestSidecarList_UnimplementedSkipsApp(t *testing.T) {
	hub := &fakeHub{unimplemented: true, pages: [][]string{{}}}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("old-app", addr))

	res, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err) // per-app failure skips the app, never errors the page
	require.Empty(t, res.Items)
}

func TestSidecarOwnsAndAppIDs(t *testing.T) {
	hub := &fakeHub{
		pages:  [][]string{{"a"}},
		states: map[string]*protos.WorkflowState{"a": wfState("a", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_RUNNING, "")},
	}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("app", addr))

	require.True(t, svc.Owns(context.Background(), "app"))
	require.False(t, svc.Owns(context.Background(), "other"))
	require.True(t, svc.HasEndpoints(context.Background()))

	ids, err := svc.AppIDs(context.Background())
	require.NoError(t, err)
	require.Equal(t, []string{"app"}, ids)
}
