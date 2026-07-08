package workflow

import (
	"github.com/dapr/durabletask-go/api/protos"
	"github.com/dapr/durabletask-go/backend/runtimestate"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// DecodeExecution builds a full Execution from an instance's history events.
func DecodeExecution(appID, instanceID string, history []*protos.HistoryEvent, customStatus string) Execution {
	var cs *wrapperspb.StringValue
	if customStatus != "" {
		cs = &wrapperspb.StringValue{Value: customStatus}
	}
	rs := runtimestate.NewOrchestrationRuntimeState(instanceID, cs, history)

	status := NormalizeStatus(runtimestate.RuntimeStatus(rs).String())
	ex := Execution{
		ExecutionSummary: ExecutionSummary{
			AppID:      appID,
			InstanceID: instanceID,
			Status:     status,
		},
		CustomStatus: customStatus,
		History:      make([]HistoryEvent, 0, len(history)),
	}
	if name, err := runtimestate.Name(rs); err == nil {
		ex.Name = name
	}
	if created, err := runtimestate.CreatedTime(rs); err == nil && !created.IsZero() {
		c := created.Local()
		ex.CreatedAt = &c
	}
	if in, err := runtimestate.Input(rs); err == nil && in != nil {
		v := in.GetValue()
		ex.Input = &v
	}
	if out, err := runtimestate.Output(rs); err == nil && out != nil {
		v := out.GetValue()
		ex.Output = &v
	}
	if fd, err := runtimestate.FailureDetails(rs); err == nil && fd != nil {
		ex.FailureDetails = failureFromProto(fd)
	}
	if status.IsTerminal() {
		if upd, err := runtimestate.LastUpdatedTime(rs); err == nil && !upd.IsZero() {
			u := upd.Local()
			ex.LastUpdatedAt = &u
		}
	}

	replays := 0
	for _, e := range history {
		if e.GetOrchestratorStarted() != nil {
			replays++
		}
		// A child workflow's own ExecutionStarted event carries its parent's
		// instance id; its presence is what marks this instance as a child.
		if es := e.GetExecutionStarted(); es != nil && ex.ParentInstanceID == "" {
			if pi := es.GetParentInstance(); pi != nil {
				if wi := pi.GetWorkflowInstance(); wi != nil {
					ex.ParentInstanceID = wi.GetInstanceId()
				}
			}
		}
		ex.History = append(ex.History, decodeEvent(e))
	}
	if replays > 0 {
		ex.ReplayCount = replays - 1
	}
	return ex
}

func decodeEvent(e *protos.HistoryEvent) HistoryEvent {
	ev := HistoryEvent{SequenceID: e.GetEventId()}
	if ts := e.GetTimestamp(); ts != nil {
		ev.Timestamp = ts.AsTime().Local()
	}
	switch {
	case e.GetExecutionStarted() != nil:
		ev.Type = "ExecutionStarted"
		s := e.GetExecutionStarted()
		ev.Name = s.GetName()
		ev.Input = strval(s.GetInput())
	case e.GetExecutionCompleted() != nil:
		c := e.GetExecutionCompleted()
		// A failed run surfaces as an ExecutionCompleted event carrying
		// FailureDetails (durabletask has no separate ExecutionFailed event); we
		// key the re-type off its presence, which mirrors the workflow-level status.
		if fd := c.GetFailureDetails(); fd != nil {
			ev.Type = "ExecutionFailed"
			ev.FailureDetails = failureFromProto(fd)
		} else {
			ev.Type = "ExecutionCompleted"
			ev.Output = strval(c.GetResult())
		}
	case e.GetExecutionTerminated() != nil:
		ev.Type = "ExecutionTerminated"
		ev.Output = strval(e.GetExecutionTerminated().GetInput())
	case e.GetExecutionSuspended() != nil:
		ev.Type = "ExecutionSuspended"
	case e.GetExecutionResumed() != nil:
		ev.Type = "ExecutionResumed"
	case e.GetTaskScheduled() != nil:
		ev.Type = "TaskScheduled"
		s := e.GetTaskScheduled()
		ev.Name = s.GetName()
		ev.Input = strval(s.GetInput())
	case e.GetTaskCompleted() != nil:
		ev.Type = "TaskCompleted"
		c := e.GetTaskCompleted()
		ev.Output = strval(c.GetResult())
		ev.ScheduledID = i32ptr(c.GetTaskScheduledId())
	case e.GetTaskFailed() != nil:
		ev.Type = "TaskFailed"
		f := e.GetTaskFailed()
		ev.ScheduledID = i32ptr(f.GetTaskScheduledId())
		ev.FailureDetails = failureFromProto(f.GetFailureDetails())
	case e.GetTimerCreated() != nil:
		ev.Type = "TimerCreated"
	case e.GetTimerFired() != nil:
		ev.Type = "TimerFired"
		ev.ScheduledID = i32ptr(e.GetTimerFired().GetTimerId())
	case e.GetEventRaised() != nil:
		ev.Type = "EventRaised"
		s := e.GetEventRaised()
		ev.Name = s.GetName()
		ev.Input = strval(s.GetInput())
	case e.GetEventSent() != nil:
		ev.Type = "EventSent"
		s := e.GetEventSent()
		ev.Name = s.GetName()
		ev.Input = strval(s.GetInput())
	case e.GetOrchestratorStarted() != nil:
		ev.Type = "OrchestratorStarted"
	case e.GetOrchestratorCompleted() != nil:
		ev.Type = "OrchestratorCompleted"
	case e.GetSubOrchestrationInstanceCreated() != nil:
		ev.Type = "SubOrchestrationCreated"
		s := e.GetSubOrchestrationInstanceCreated()
		ev.Name = s.GetName()
		ev.InstanceID = s.GetInstanceId()
	case e.GetChildWorkflowInstanceCompleted() != nil:
		ev.Type = "SubOrchestrationCompleted"
		c := e.GetChildWorkflowInstanceCompleted()
		ev.Output = strval(c.GetResult())
		ev.ScheduledID = i32ptr(c.GetTaskScheduledId())
	case e.GetChildWorkflowInstanceFailed() != nil:
		ev.Type = "SubOrchestrationFailed"
		f := e.GetChildWorkflowInstanceFailed()
		ev.ScheduledID = i32ptr(f.GetTaskScheduledId())
		ev.FailureDetails = failureFromProto(f.GetFailureDetails())
	default:
		ev.Type = "Unknown"
	}
	return ev
}

func strval(v *wrapperspb.StringValue) *string {
	if v == nil {
		return nil
	}
	s := v.GetValue()
	return &s
}

func i32ptr(v int32) *int32 { return &v }

func failureFromProto(fd *protos.TaskFailureDetails) *FailureDetails {
	if fd == nil {
		return nil
	}
	return &FailureDetails{
		ErrorType:  fd.GetErrorType(),
		Message:    fd.GetErrorMessage(),
		StackTrace: fd.GetStackTrace().GetValue(),
	}
}
