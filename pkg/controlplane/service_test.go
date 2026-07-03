//go:build unit

package controlplane

import (
	"context"
	"errors"
	"os"
	"testing"
)

// fakeRunner returns canned output/err keyed by the first two args joined.
type fakeRunner struct {
	calls       [][]string
	outputs     map[string][]byte
	errs        map[string]error
	streamLines []string
	streamCalls [][]string
}

func (f *fakeRunner) run(_ context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	key := args[0]
	if len(args) > 1 {
		key = args[0] + " " + args[1]
	}
	return f.outputs[key], f.errs[key]
}

func (f *fakeRunner) stream(_ context.Context, args ...string) (<-chan string, error) {
	f.streamCalls = append(f.streamCalls, args)
	ch := make(chan string)
	go func() {
		defer close(ch)
		for _, l := range f.streamLines {
			ch <- l
		}
	}()
	return ch, nil
}

func TestListUnavailableWhenNoRuntime(t *testing.T) {
	m := newManager(RuntimeNone, nil)
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if res.Available {
		t.Error("Available = true, want false when no runtime")
	}
}

func TestListRunningService(t *testing.T) {
	inspect, _ := os.ReadFile("testdata/inspect_running.json")
	stats, _ := os.ReadFile("testdata/stats.json")
	f := &fakeRunner{
		outputs: map[string][]byte{
			"inspect dapr_scheduler": inspect,
			"inspect dapr_placement": inspect,
			"stats --no-stream":      stats,
		},
	}
	m := newManager(RuntimeDocker, f)
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if !res.Available {
		t.Fatal("Available = false, want true")
	}
	if !res.Reachable {
		t.Error("Reachable = false, want true")
	}
	if !res.ControlPlanePresent {
		t.Error("ControlPlanePresent = false, want true (containers found)")
	}
	// 2 live + 2 k8s-only placeholders
	if len(res.Services) != 4 {
		t.Fatalf("len(Services) = %d, want 4", len(res.Services))
	}
	sched := res.Services[0]
	if sched.Name != "dapr_scheduler" || sched.Status != StatusRunning || !sched.Healthy {
		t.Errorf("scheduler = %+v, want running+healthy", sched)
	}
	if sched.MemoryBytes == 0 {
		t.Error("scheduler MemoryBytes = 0, want > 0")
	}
	// last two are k8s-only, non-actionable
	k8s := res.Services[3]
	if k8s.Status != StatusK8sOnly || k8s.Actionable {
		t.Errorf("k8s placeholder = %+v, want kubernetes-only + non-actionable", k8s)
	}
}

func TestLogStreamValidation(t *testing.T) {
	m := newManager(RuntimeDocker, &fakeRunner{outputs: map[string][]byte{}})
	if _, err := m.LogStream(context.Background(), "dapr_redis"); err != ErrUnknownService {
		t.Errorf("unknown name: got %v, want ErrUnknownService", err)
	}
	none := newManager(RuntimeNone, nil)
	if _, err := none.LogStream(context.Background(), "dapr_scheduler"); err != ErrRuntimeUnavailable {
		t.Errorf("no runtime: got %v, want ErrRuntimeUnavailable", err)
	}
}

func TestLogStreamEmitsLines(t *testing.T) {
	f := &fakeRunner{streamLines: []string{"line one", "line two"}}
	m := newManager(RuntimeDocker, f)
	ch, err := m.LogStream(context.Background(), "dapr_scheduler")
	if err != nil {
		t.Fatalf("LogStream: %v", err)
	}
	got := []string{}
	for l := range ch {
		got = append(got, l)
	}
	if len(got) != 2 || got[0] != "line one" {
		t.Errorf("lines = %v", got)
	}
	// confirm it invoked `logs -f ... dapr_scheduler`
	last := f.streamCalls[len(f.streamCalls)-1]
	if last[0] != "logs" {
		t.Errorf("stream args = %v, want logs ...", last)
	}
}

func TestListUnreachableDaemon(t *testing.T) {
	f := &fakeRunner{
		errs: map[string]error{
			"info": errors.New("cannot connect to docker daemon"),
		},
	}
	m := newManager(RuntimeDocker, f)
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if !res.Available {
		t.Error("Available = false, want true (runtime is installed)")
	}
	if res.Reachable {
		t.Error("Reachable = true, want false (daemon unreachable)")
	}
	if len(res.Services) != 0 {
		t.Errorf("len(Services) = %d, want 0 when daemon unreachable", len(res.Services))
	}
}

func TestListReachableButNoContainers(t *testing.T) {
	stats, _ := os.ReadFile("testdata/stats.json")
	f := &fakeRunner{
		outputs: map[string][]byte{
			"stats --no-stream": stats,
		},
		errs: map[string]error{
			"inspect dapr_scheduler": errors.New("no such container"),
			"inspect dapr_placement": errors.New("no such container"),
		},
	}
	m := newManager(RuntimeDocker, f)
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if !res.Available {
		t.Error("Available = false, want true")
	}
	if !res.Reachable {
		t.Error("Reachable = false, want true")
	}
	if res.ControlPlanePresent {
		t.Error("ControlPlanePresent = true, want false (no containers)")
	}
	// still returns 4 services (2 live + 2 k8s placeholders)
	if len(res.Services) != 4 {
		t.Fatalf("len(Services) = %d, want 4", len(res.Services))
	}
}

func TestDoValidation(t *testing.T) {
	f := &fakeRunner{outputs: map[string][]byte{}}
	m := newManager(RuntimeDocker, f)
	if err := m.Do(context.Background(), "kill", "dapr_scheduler"); !errors.Is(err, ErrInvalidAction) {
		t.Errorf("kill: got %v, want ErrInvalidAction", err)
	}
	if err := m.Do(context.Background(), "start", "dapr_redis"); !errors.Is(err, ErrUnknownService) {
		t.Errorf("dapr_redis: got %v, want ErrUnknownService", err)
	}
	if err := m.Do(context.Background(), "restart", "dapr_scheduler"); err != nil {
		t.Errorf("valid restart: got %v, want nil", err)
	}
	last := f.calls[len(f.calls)-1]
	if last[0] != "restart" || last[1] != "dapr_scheduler" {
		t.Errorf("ran %v, want [restart dapr_scheduler]", last)
	}
}
