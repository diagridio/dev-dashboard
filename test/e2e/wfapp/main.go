// Command wfapp is a minimal Dapr workflow app used only by the e2e tests.
// It schedules one workflow instance, waits for it to complete, then prints
// a marker line so the test can read the resulting state back from the
// actor state store.
//
// The go-sdk version is chosen at image build time (GO_SDK_VERSION build
// arg) so CI pairs each Dapr runtime line with its matching SDK release.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"runtime/debug"
	"time"

	"github.com/dapr/durabletask-go/workflow"
	"github.com/dapr/go-sdk/client"
)

const instanceID = "e2e-order-1"

// OrderWorkflow calls one activity and returns its result.
func OrderWorkflow(ctx *workflow.WorkflowContext) (any, error) {
	var out string
	if err := ctx.CallActivity(Notify, workflow.WithActivityInput("order")).Await(&out); err != nil {
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

// goSDKVersion is the github.com/dapr/go-sdk version compiled into this binary.
func goSDKVersion() string {
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "github.com/dapr/go-sdk" {
				if d.Replace != nil {
					return d.Replace.Version
				}
				return d.Version
			}
		}
	}
	return "unknown"
}

func main() {
	// -sdk-version lets the e2e tests check the GO_SDK_VERSION build arg took
	// effect without starting a workflow; the marker line does the same in logs.
	if len(os.Args) > 1 && os.Args[1] == "-sdk-version" {
		fmt.Println(goSDKVersion())
		return
	}
	fmt.Printf("WFAPP_GO_SDK %s\n", goSDKVersion())

	r := workflow.NewRegistry()
	if err := r.AddWorkflow(OrderWorkflow); err != nil {
		log.Fatalf("register workflow: %v", err)
	}
	if err := r.AddActivity(Notify); err != nil {
		log.Fatalf("register activity: %v", err)
	}

	wc, err := client.NewWorkflowClient()
	if err != nil {
		log.Fatalf("new workflow client: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := wc.StartWorker(ctx, r); err != nil {
		log.Fatalf("start worker: %v", err)
	}

	id, err := wc.ScheduleWorkflow(ctx, "OrderWorkflow", workflow.WithInstanceID(instanceID))
	if err != nil {
		log.Fatalf("schedule: %v", err)
	}
	if _, err := wc.WaitForWorkflowCompletion(ctx, id); err != nil {
		log.Fatalf("wait: %v", err)
	}

	// Brief grace period so the runtime flushes final state to the store.
	time.Sleep(500 * time.Millisecond)
	fmt.Printf("WORKFLOW_DONE %s\n", id)
	os.Exit(0)
}
