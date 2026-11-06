package main

import (
	"errors"
	"fmt"
	"time"

	"github.com/dapr/durabletask-go/workflow"
)

// CheckInput is the input of the SubsystemCheck workflow and RunCheck activity.
type CheckInput struct {
	Sweep     Sweep  `json:"sweep"`
	Subsystem string `json:"subsystem"`
}

// DiagnosticSweep fans out one SubsystemCheck child per subsystem, then
// compiles the report.
func DiagnosticSweep(ctx *workflow.WorkflowContext) (any, error) {
	var sweep Sweep
	if err := ctx.GetInput(&sweep); err != nil {
		return nil, err
	}
	tasks := make([]workflow.Task, 0, len(Subsystems))
	for _, sub := range Subsystems {
		tasks = append(tasks, ctx.CallChildWorkflow("SubsystemCheck",
			workflow.WithChildWorkflowInput(CheckInput{Sweep: sweep, Subsystem: sub}),
			workflow.WithChildWorkflowInstanceID(ChildID(sweep.ID, sub))))
	}
	var errs []error // first failure wins; the rest are in the children
	results := map[string]string{}
	for i, t := range tasks {
		var res string
		if err := t.Await(&res); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", Subsystems[i], err))
			continue
		}
		results[Subsystems[i]] = res
	}
	if len(errs) > 0 {
		return nil, errs[0]
	}

	var report any = map[string]any{"sweepId": sweep.ID, "results": results}
	if sweep.LargePayload {
		report = PayloadRef()
	}
	var out string
	if err := ctx.CallActivity("CompileReport", workflow.WithActivityInput(report)).Await(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// SubsystemCheck runs one subsystem check; for sign-off sweeps the affected
// subsystem then waits for an external event that is never raised.
func SubsystemCheck(ctx *workflow.WorkflowContext) (any, error) {
	var in CheckInput
	if err := ctx.GetInput(&in); err != nil {
		return nil, err
	}
	// A short durable timer so the history shows TimerCreated/TimerFired.
	if err := ctx.CreateTimer(2 * time.Second).Await(nil); err != nil {
		return nil, err
	}
	var res string
	if err := ctx.CallActivity("RunCheck", workflow.WithActivityInput(in)).Await(&res); err != nil {
		return nil, err
	}
	if in.Sweep.Outcome == AwaitSignOff && in.Sweep.Subsystem == in.Subsystem {
		// A negative timeout waits forever (zero would cancel immediately).
		if err := ctx.WaitForExternalEvent(in.Sweep.EventName, -1).Await(nil); err != nil {
			return nil, err
		}
	}
	return res, nil
}

// RunCheck performs the check and fails for the Fail scenario's subsystem.
func RunCheck(ctx workflow.ActivityContext) (any, error) {
	var in CheckInput
	if err := ctx.GetInput(&in); err != nil {
		return nil, err
	}
	if in.Sweep.Outcome == Fail && in.Sweep.Subsystem == in.Subsystem {
		return nil, errors.New(in.Sweep.Message)
	}
	return in.Subsystem + ": nominal", nil
}

// CompileReport summarises the sweep. Its input may be a $daprRef envelope.
func CompileReport(ctx workflow.ActivityContext) (any, error) {
	var in map[string]any
	if err := ctx.GetInput(&in); err != nil {
		return nil, err
	}
	return "report compiled", nil
}
