//go:build unit

package workflow

import (
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

func TestDecodeExecutionRunning(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: -1, Timestamp: now, EventType: &protos.HistoryEvent_WorkflowStarted{WorkflowStarted: &protos.WorkflowStartedEvent{}}},
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
			Name:  "OrderWorkflow",
			Input: &wrapperspb.StringValue{Value: `{"id":1}`},
		}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_TaskScheduled{TaskScheduled: &protos.TaskScheduledEvent{Name: "Charge"}}},
	}
	ex := DecodeExecution("order", "inst-1", history, "step 2/3")

	require.Equal(t, "order", ex.AppID)
	require.Equal(t, "inst-1", ex.InstanceID)
	require.Equal(t, "OrderWorkflow", ex.Name)
	require.Equal(t, StatusRunning, ex.Status)
	require.NotNil(t, ex.CreatedAt)
	require.Nil(t, ex.LastUpdatedAt) // not terminal
	require.NotNil(t, ex.Input)
	require.Equal(t, `{"id":1}`, *ex.Input)
	require.Equal(t, "step 2/3", ex.CustomStatus)
	require.Len(t, ex.History, 3)
	require.Equal(t, "ExecutionStarted", ex.History[1].Type)
	require.Equal(t, "Charge", ex.History[2].Name)
	require.Equal(t, 0, ex.ReplayCount)
	require.Equal(t, "OrchestratorStarted", ex.History[0].Type)
}

func TestDecodeExecutionReplayCount(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: -1, Timestamp: now, EventType: &protos.HistoryEvent_WorkflowStarted{WorkflowStarted: &protos.WorkflowStartedEvent{}}},
		{EventId: -1, Timestamp: now, EventType: &protos.HistoryEvent_WorkflowStarted{WorkflowStarted: &protos.WorkflowStartedEvent{}}},
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
			Name: "OrderWorkflow",
		}}},
	}
	ex := DecodeExecution("order", "inst-3", history, "")
	require.Equal(t, 1, ex.ReplayCount)
}

func TestDecodeExecutionCompleted(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{Name: "W"}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionCompleted{ExecutionCompleted: &protos.ExecutionCompletedEvent{
			WorkflowStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			Result:         &wrapperspb.StringValue{Value: `"done"`},
		}}},
	}
	ex := DecodeExecution("order", "inst-2", history, "")
	require.Equal(t, StatusCompleted, ex.Status)
	require.NotNil(t, ex.LastUpdatedAt)
	require.NotNil(t, ex.Output)
	require.Equal(t, `"done"`, *ex.Output)
}

func TestDecodeExecutionParentInstanceID(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
			Name: "ChildWorkflow",
			ParentInstance: &protos.ParentInstanceInfo{
				WorkflowInstance: &protos.WorkflowInstance{InstanceId: "parent-inst-1"},
			},
		}}},
	}
	ex := DecodeExecution("order", "child-inst-1", history, "")
	require.Equal(t, "parent-inst-1", ex.ParentInstanceID)
}

func i32(v int32) *int32 { return &v }

func TestDecodeScheduledID(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{Name: "W"}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_TaskScheduled{TaskScheduled: &protos.TaskScheduledEvent{Name: "A"}}},
		{EventId: 2, Timestamp: now, EventType: &protos.HistoryEvent_TaskCompleted{TaskCompleted: &protos.TaskCompletedEvent{TaskScheduledId: 1, Result: &wrapperspb.StringValue{Value: `"ok"`}}}},
		{EventId: 3, Timestamp: now, EventType: &protos.HistoryEvent_TaskScheduled{TaskScheduled: &protos.TaskScheduledEvent{Name: "B"}}},
		{EventId: 4, Timestamp: now, EventType: &protos.HistoryEvent_TaskFailed{TaskFailed: &protos.TaskFailedEvent{TaskScheduledId: 3}}},
		{EventId: 5, Timestamp: now, EventType: &protos.HistoryEvent_TimerCreated{TimerCreated: &protos.TimerCreatedEvent{}}},
		{EventId: 6, Timestamp: now, EventType: &protos.HistoryEvent_TimerFired{TimerFired: &protos.TimerFiredEvent{TimerId: 5}}},
		{EventId: 7, Timestamp: now, EventType: &protos.HistoryEvent_ChildWorkflowInstanceCreated{ChildWorkflowInstanceCreated: &protos.ChildWorkflowInstanceCreatedEvent{InstanceId: "c1", Name: "Child"}}},
		{EventId: 8, Timestamp: now, EventType: &protos.HistoryEvent_ChildWorkflowInstanceCompleted{ChildWorkflowInstanceCompleted: &protos.ChildWorkflowInstanceCompletedEvent{TaskScheduledId: 7, Result: &wrapperspb.StringValue{Value: `"cdone"`}}}},
		{EventId: 9, Timestamp: now, EventType: &protos.HistoryEvent_ChildWorkflowInstanceFailed{ChildWorkflowInstanceFailed: &protos.ChildWorkflowInstanceFailedEvent{TaskScheduledId: 7}}},
	}
	ex := DecodeExecution("app", "inst", history, "")

	byType := map[string]HistoryEvent{}
	for _, e := range ex.History {
		byType[e.Type] = e
	}

	require.NotNil(t, byType["TaskCompleted"].ScheduledID)
	require.Equal(t, int32(1), *byType["TaskCompleted"].ScheduledID)
	require.Equal(t, `"ok"`, *byType["TaskCompleted"].Output)

	require.NotNil(t, byType["TaskFailed"].ScheduledID)
	require.Equal(t, int32(3), *byType["TaskFailed"].ScheduledID)

	require.NotNil(t, byType["TimerFired"].ScheduledID)
	require.Equal(t, int32(5), *byType["TimerFired"].ScheduledID)

	require.Equal(t, "SubOrchestrationCompleted", byType["SubOrchestrationCompleted"].Type)
	require.NotNil(t, byType["SubOrchestrationCompleted"].ScheduledID)
	require.Equal(t, int32(7), *byType["SubOrchestrationCompleted"].ScheduledID)
	require.Equal(t, `"cdone"`, *byType["SubOrchestrationCompleted"].Output)

	require.Equal(t, "SubOrchestrationFailed", byType["SubOrchestrationFailed"].Type)
	require.NotNil(t, byType["SubOrchestrationFailed"].ScheduledID)
	require.Equal(t, int32(7), *byType["SubOrchestrationFailed"].ScheduledID)

	// Start events carry no back-reference.
	require.Nil(t, byType["TaskScheduled"].ScheduledID)
}

func TestDecodeSubOrchestrationCreated(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{Name: "ParentWorkflow"}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_ChildWorkflowInstanceCreated{ChildWorkflowInstanceCreated: &protos.ChildWorkflowInstanceCreatedEvent{
			InstanceId: "child-inst-9",
			Name:       "ChildWorkflow",
		}}},
	}
	ex := DecodeExecution("order", "parent-inst-1", history, "")
	require.Equal(t, "", ex.ParentInstanceID) // parent has no parent
	require.Len(t, ex.History, 2)
	require.Equal(t, "SubOrchestrationCreated", ex.History[1].Type)
	require.Equal(t, "ChildWorkflow", ex.History[1].Name)
	require.Equal(t, "child-inst-9", ex.History[1].InstanceID)
}
