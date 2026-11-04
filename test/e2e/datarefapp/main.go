// Command datarefapp is a Dapr 1.19+ fixture used only by the e2e tests. It
// mimics what the .NET / JS SDKs do for workflow data references (dapr/proposals
// #109): it stores a JSON payload in a binary store through the sidecar's
// SetBinaryFileAlpha1 gRPC API, then schedules a workflow whose input is the
// {"$daprRef":{...}} envelope pointing at that file. The Go SDK has no
// data-reference support, so the envelope is built by hand.
//
// When done it prints
//
//	DATAREF_DONE <instanceID> <store> <key> <size> <sha256>
//
// so the test knows exactly what the dashboard should serve.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"time"

	commonv1pb "github.com/dapr/dapr/pkg/proto/common/v1"
	runtimev1pb "github.com/dapr/dapr/pkg/proto/runtime/v1"
	"github.com/dapr/durabletask-go/workflow"
	"github.com/dapr/go-sdk/client"
	"google.golang.org/grpc"
)

const (
	instanceID = "e2e-dataref-1"
	store      = "payloads"
)

// payload is the offloaded workflow input. Deterministic so reruns hash the same.
var payload = []byte(`{"orderId":"e2e-dataref-1","items":[{"sku":"A-1","qty":2},{"sku":"B-7","qty":1}],"note":"stored in a Dapr binary store"}`)

// DataRefWorkflow receives the envelope as its input and completes.
func DataRefWorkflow(ctx *workflow.WorkflowContext) (any, error) {
	var in map[string]any
	if err := ctx.GetInput(&in); err != nil {
		return nil, err
	}
	return "received", nil
}

func main() {
	sum := sha256.Sum256(payload)
	sha := hex.EncodeToString(sum[:])
	key := fmt.Sprintf("workflow-payloads/%s/%s", instanceID, sha)

	dc, err := client.NewClient()
	if err != nil {
		log.Fatalf("new client: %v", err)
	}
	defer dc.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// The sidecar may still be loading components; retry until it accepts.
	var upErr error
	for range 60 {
		if upErr = upload(ctx, dc.GrpcClientConn(), key, payload); upErr == nil {
			break
		}
		time.Sleep(time.Second)
	}
	if upErr != nil {
		log.Fatalf("upload: %v", upErr)
	}

	r := workflow.NewRegistry()
	if err := r.AddWorkflow(DataRefWorkflow); err != nil {
		log.Fatalf("register workflow: %v", err)
	}
	wc, err := client.NewWorkflowClient()
	if err != nil {
		log.Fatalf("new workflow client: %v", err)
	}
	if err := wc.StartWorker(ctx, r); err != nil {
		log.Fatalf("start worker: %v", err)
	}

	envelope := map[string]any{"$daprRef": map[string]any{
		"v": 1, "store": store, "key": key, "size": len(payload), "sha256": sha,
	}}
	id, err := wc.ScheduleWorkflow(ctx, "DataRefWorkflow",
		workflow.WithInstanceID(instanceID), workflow.WithInput(envelope))
	if err != nil {
		log.Fatalf("schedule: %v", err)
	}
	if _, err := wc.WaitForWorkflowCompletion(ctx, id); err != nil {
		log.Fatalf("wait: %v", err)
	}

	// Brief grace period so the runtime flushes final state to the store.
	time.Sleep(500 * time.Millisecond)
	fmt.Printf("DATAREF_DONE %s %s %s %d %s\n", id, store, key, len(payload), sha)
	os.Exit(0)
}

// upload stores data under key with the streaming SetBinaryFileAlpha1 API:
// one initial message naming the component and file, then the bytes.
func upload(ctx context.Context, conn *grpc.ClientConn, key string, data []byte) error {
	stream, err := runtimev1pb.NewDaprClient(conn).SetBinaryFileAlpha1(ctx)
	if err != nil {
		return err
	}
	overwrite := true
	if err := stream.Send(&runtimev1pb.SetBinaryFileRequestAlpha1{
		SetBinaryFileRequestType: &runtimev1pb.SetBinaryFileRequestAlpha1_InitialRequest{
			InitialRequest: &runtimev1pb.SetBinaryFileRequestInitialAlpha1{
				ComponentName: store, FileName: key, Overwrite: &overwrite,
			},
		},
	}); err != nil {
		return err
	}
	if err := stream.Send(&runtimev1pb.SetBinaryFileRequestAlpha1{
		SetBinaryFileRequestType: &runtimev1pb.SetBinaryFileRequestAlpha1_Payload{
			Payload: &commonv1pb.StreamPayload{Data: data, Seq: 0},
		},
	}); err != nil {
		return err
	}
	_, err = stream.CloseAndRecv()
	return err
}
