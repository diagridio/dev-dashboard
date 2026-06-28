// Command wfapp is a minimal Dapr workflow app used only by the e2e test.
// Run under `dapr run`, it schedules one workflow instance, waits for it to
// complete, then prints a marker line so the test can read the resulting
// state back from the actor state store.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/dapr/go-sdk/workflow"
)

const instanceID = "e2e-order-1"

// OrderWorkflow calls one activity and returns its result.
func OrderWorkflow(ctx *workflow.WorkflowContext) (any, error) {
	var out string
	if err := ctx.CallActivity(Notify, workflow.ActivityInput("order")).Await(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// Notify is a trivial activity returning a deterministic string.
func Notify(ctx workflow.ActivityContext) (any, error) {
	var in string
	if err := ctx.GetInput(&in); err != nil {
		return nil, err
	}
	return "notified:" + in, nil
}

func main() {
	w, err := workflow.NewWorker()
	if err != nil {
		log.Fatalf("new worker: %v", err)
	}
	if err := w.RegisterWorkflow(OrderWorkflow); err != nil {
		log.Fatalf("register workflow: %v", err)
	}
	if err := w.RegisterActivity(Notify); err != nil {
		log.Fatalf("register activity: %v", err)
	}
	if err := w.Start(); err != nil {
		log.Fatalf("start worker: %v", err)
	}
	defer func() { _ = w.Shutdown() }()

	client, err := workflow.NewClient()
	if err != nil {
		log.Fatalf("new client: %v", err)
	}
	ctx := context.Background()

	id, err := client.ScheduleNewWorkflow(ctx, "OrderWorkflow", workflow.WithInstanceID(instanceID))
	if err != nil {
		log.Fatalf("schedule: %v", err)
	}
	if _, err := client.WaitForWorkflowCompletion(ctx, id, workflow.WithFetchPayloads(true)); err != nil {
		log.Fatalf("wait: %v", err)
	}

	// Brief grace period so the runtime flushes final state to the store.
	time.Sleep(500 * time.Millisecond)
	fmt.Printf("WORKFLOW_DONE %s\n", id)
	os.Exit(0)
}
