package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	commonv1pb "github.com/dapr/dapr/pkg/proto/common/v1"
	runtimev1pb "github.com/dapr/dapr/pkg/proto/runtime/v1"
	"github.com/dapr/durabletask-go/workflow"
	"github.com/dapr/go-sdk/client"
	"google.golang.org/grpc"
)

// sdkClient adapts the go-sdk workflow client to workflowClient.
type sdkClient struct{ wc *workflow.Client }

func (s sdkClient) Exists(ctx context.Context, id string) (bool, error) {
	_, err := s.wc.FetchWorkflowMetadata(ctx, id)
	if err == nil {
		return true, nil
	}
	if ignorable(err) {
		return false, nil
	}
	return false, err
}

func (s sdkClient) Schedule(ctx context.Context, name, id string, input any) error {
	_, err := s.wc.ScheduleWorkflow(ctx, name, workflow.WithInstanceID(id), workflow.WithInput(input))
	return err
}

// Terminate stops the sweep's subsystem children first and the sweep last,
// waiting for each to become terminal. Terminating the parent recursively
// instead leaves child->parent completion reminders behind that wedge the
// instance when it is purged and seeded again.
func (s sdkClient) Terminate(ctx context.Context, id string) error {
	ids := make([]string, 0, len(Subsystems)+1)
	for _, sub := range Subsystems {
		ids = append(ids, ChildID(id, sub))
	}
	ids = append(ids, id)
	var first error
	for _, one := range ids {
		if err := s.wc.TerminateWorkflow(ctx, one); err != nil {
			if !ignorable(err) && first == nil {
				first = err
			}
			continue
		}
		wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, _ = s.wc.WaitForWorkflowCompletion(wctx, one)
		cancel()
	}
	return first
}

// PurgeRecursive retries briefly: a just-terminated instance can still be
// reported as running for a moment.
func (s sdkClient) PurgeRecursive(ctx context.Context, id string) error {
	var err error
	for range 20 {
		if err = s.wc.PurgeWorkflowState(ctx, id, workflow.WithRecursivePurge(true)); err == nil || ignorable(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return err
}

func (s sdkClient) Status(ctx context.Context, id string) (string, error) {
	m, err := s.wc.FetchWorkflowMetadata(ctx, id)
	if err != nil {
		return "", err
	}
	return m.String(), nil
}

// grpcStore uploads through the sidecar's SetBinaryFileAlpha1 API.
type grpcStore struct{ conn *grpc.ClientConn }

func (g grpcStore) Put(ctx context.Context, key string, data []byte) error {
	stream, err := runtimev1pb.NewDaprClient(g.conn).SetBinaryFileAlpha1(ctx)
	if err != nil {
		return err
	}
	overwrite := true
	if err := stream.Send(&runtimev1pb.SetBinaryFileRequestAlpha1{
		SetBinaryFileRequestType: &runtimev1pb.SetBinaryFileRequestAlpha1_InitialRequest{
			InitialRequest: &runtimev1pb.SetBinaryFileRequestInitialAlpha1{
				ComponentName: payloadStoreName, FileName: key, Overwrite: &overwrite,
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

func main() {
	dc, err := client.NewClient()
	if err != nil {
		log.Fatalf("new client: %v", err)
	}
	defer dc.Close()

	r := workflow.NewRegistry()
	for _, w := range []func(*workflow.WorkflowContext) (any, error){DiagnosticSweep, SubsystemCheck} {
		if err := r.AddWorkflow(w); err != nil {
			log.Fatalf("register workflow: %v", err)
		}
	}
	for _, a := range []func(workflow.ActivityContext) (any, error){RunCheck, CompileReport} {
		if err := r.AddActivity(a); err != nil {
			log.Fatalf("register activity: %v", err)
		}
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

	sc := sdkClient{wc}
	ctrl := NewController(sc, grpcStore{dc.GrpcClientConn()}, sc.Status)
	go func() {
		if err := ctrl.SeedWithRetry(ctx, 2*time.Minute); err != nil {
			log.Printf("seed failed: %v", err)
			return
		}
		log.Println("demo seeded")
	}()

	port := strings.TrimSpace(os.Getenv("APP_PORT"))
	if port == "" {
		port = "6001"
	}
	addr := "127.0.0.1:" + port
	log.Printf("engineering listening on %s", addr)
	if err := http.ListenAndServe(addr, ctrl.Handler()); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
