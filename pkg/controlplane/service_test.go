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

func (f *fakeRunner) Run(_ context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	key := args[0]
	if len(args) > 1 {
		key = args[0] + " " + args[1]
	}
	return f.outputs[key], f.errs[key]
}

func (f *fakeRunner) Stream(_ context.Context, args ...string) (<-chan string, error) {
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
	m := newManager(RuntimeNone, nil, AllSources())
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
	m := newManager(RuntimeDocker, f, AllSources())
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
	if len(res.Services) != 2 {
		t.Fatalf("len(Services) = %d, want 2", len(res.Services))
	}
	sched := res.Services[0]
	if sched.Name != "dapr_scheduler" || sched.Status != StatusRunning || !sched.Healthy {
		t.Errorf("scheduler = %+v, want running+healthy", sched)
	}
	if sched.MemoryBytes == 0 {
		t.Error("scheduler MemoryBytes = 0, want > 0")
	}
}

func TestLogStreamValidation(t *testing.T) {
	m := newManager(RuntimeDocker, &fakeRunner{outputs: map[string][]byte{}}, AllSources())
	if _, err := m.LogStream(context.Background(), "dapr_redis"); err != ErrUnknownService {
		t.Errorf("unknown name: got %v, want ErrUnknownService", err)
	}
	none := newManager(RuntimeNone, nil, AllSources())
	if _, err := none.LogStream(context.Background(), "dapr_scheduler"); err != ErrRuntimeUnavailable {
		t.Errorf("no runtime: got %v, want ErrRuntimeUnavailable", err)
	}
}

func TestLogStreamEmitsLines(t *testing.T) {
	f := &fakeRunner{streamLines: []string{"line one", "line two"}}
	m := newManager(RuntimeDocker, f, AllSources())
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
	m := newManager(RuntimeDocker, f, AllSources())
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
	m := newManager(RuntimeDocker, f, AllSources())
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
	if len(res.Services) != 2 {
		t.Fatalf("len(Services) = %d, want 2", len(res.Services))
	}
	// A stopped/absent container has no port bindings; Ports must be a non-nil
	// empty slice so it marshals to JSON [] (not null) and never breaks the
	// frontend's svc.ports.length.
	for _, svc := range res.Services[:len(LiveServiceNames)] {
		if svc.Ports == nil {
			t.Errorf("%s: Ports is nil, want non-nil empty slice", svc.Name)
		}
	}
}

func TestListIncludesComposeControlPlane(t *testing.T) {
	inspect, err := os.ReadFile("testdata/compose_cp_inspect.json")
	if err != nil {
		t.Fatal(err)
	}
	stats, _ := os.ReadFile("testdata/stats.json")
	f := &fakeRunner{
		outputs: map[string][]byte{
			"ps -aq":            []byte("p1\ns0\nx1\n"),
			"inspect p1":        inspect,
			"stats --no-stream": stats,
		},
	}
	m := newManager(RuntimeDocker, f, AllSources())
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var compose []Service
	for _, s := range res.Services {
		if s.ComposeProject != "" {
			compose = append(compose, s)
		}
	}
	if len(compose) != 2 {
		t.Fatalf("want placement + scheduler, got %+v", compose)
	}
	if compose[0].Name != "saga-placement-1" || !compose[0].Actionable || compose[0].ComposeProject != "saga" {
		t.Fatalf("placement: %+v", compose[0])
	}
	if compose[1].Name != "saga-scheduler-0-1" {
		t.Fatalf("scheduler: %+v", compose[1])
	}
	// postgres-db must NOT be listed (not a control-plane command).
}

func TestDoAllowsDiscoveredComposeNames(t *testing.T) {
	inspect, err := os.ReadFile("testdata/compose_cp_inspect.json")
	if err != nil {
		t.Fatal(err)
	}
	stats, _ := os.ReadFile("testdata/stats.json")
	f := &fakeRunner{
		outputs: map[string][]byte{
			"ps -aq":            []byte("p1\ns0\nx1\n"),
			"inspect p1":        inspect,
			"stats --no-stream": stats,
		},
	}
	m := newManager(RuntimeDocker, f, AllSources())
	// Call List first to populate the allowlist.
	if _, err := m.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Discovered compose name must be allowed.
	if err := m.Do(context.Background(), "restart", "saga-placement-1"); err != nil {
		t.Errorf("restart saga-placement-1: got %v, want nil", err)
	}
	// Non-CP compose container must be rejected.
	if err := m.Do(context.Background(), "restart", "saga-postgres-db-1"); !errors.Is(err, ErrUnknownService) {
		t.Errorf("saga-postgres-db-1: got %v, want ErrUnknownService", err)
	}
	// Fixed dapr_* names must still work.
	if err := m.Do(context.Background(), "restart", "dapr_placement"); err != nil {
		t.Errorf("restart dapr_placement: got %v, want nil", err)
	}
}

func TestDoRejectsComposeNamesBeforeList(t *testing.T) {
	f := &fakeRunner{
		outputs: map[string][]byte{},
	}
	m := newManager(RuntimeDocker, f, AllSources())
	// No List call — compose names must be rejected.
	if err := m.Do(context.Background(), "restart", "saga-placement-1"); !errors.Is(err, ErrUnknownService) {
		t.Errorf("before List: got %v, want ErrUnknownService", err)
	}
}

func TestDoValidation(t *testing.T) {
	f := &fakeRunner{outputs: map[string][]byte{}}
	m := newManager(RuntimeDocker, f, AllSources())
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

func TestListInitOnlyExcludesCompose(t *testing.T) {
	f := &fakeRunner{outputs: map[string][]byte{
		"info":                   []byte("ok"),
		"inspect dapr_scheduler": []byte("[]"),
		"inspect dapr_placement": []byte("[]"),
	}}
	m := newManager(RuntimeDocker, f, Sources{Init: true})
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, s := range res.Services {
		if s.ComposeProject != "" {
			t.Fatalf("init-only sources must not list compose services, got %+v", s)
		}
	}
	if len(res.Services) != len(LiveServiceNames) {
		t.Fatalf("want the %d init services, got %d", len(LiveServiceNames), len(res.Services))
	}
}

func TestListComposeOnlyExcludesInit(t *testing.T) {
	f := &fakeRunner{outputs: map[string][]byte{
		"info":   []byte("ok"),
		"ps -aq": []byte(""), // no compose containers running
	}}
	m := newManager(RuntimeDocker, f, Sources{Compose: true})
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Services) != 0 {
		t.Fatalf("compose-only sources must not list the dapr_* init services, got %+v", res.Services)
	}
}

func TestListEmptySourcesIsHonestEmpty(t *testing.T) {
	f := &fakeRunner{outputs: map[string][]byte{"info": []byte("ok")}}
	m := newManager(RuntimeDocker, f, Sources{})
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Available || !res.Reachable || len(res.Services) != 0 {
		t.Fatalf("want available+reachable with zero services, got %+v", res)
	}
}

func TestListEmptySourcesNeverCallsStats(t *testing.T) {
	// docker stats --no-stream with no names samples ALL running containers
	// (~1-2s block) and the result would be discarded — with Sources{} (e.g.
	// test-containers mode) List must skip the call entirely. Deliberately
	// give the fakeRunner NO "stats --no-stream" output key: if List called
	// it anyway, memory() would just return an empty map (masking the bug),
	// so we additionally assert on f.calls that the runner was never invoked
	// with a stats command.
	f := &fakeRunner{outputs: map[string][]byte{"info": []byte("ok")}}
	m := newManager(RuntimeDocker, f, Sources{})
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Available || !res.Reachable || len(res.Services) != 0 {
		t.Fatalf("want available+reachable with zero services, got %+v", res)
	}
	for _, call := range f.calls {
		if len(call) > 0 && call[0] == "stats" {
			t.Fatalf("List invoked stats with Sources{}, want no stats call: %v", call)
		}
	}
}

func TestDoAndLogStreamRespectSources(t *testing.T) {
	m := newManager(RuntimeDocker, &fakeRunner{outputs: map[string][]byte{}}, Sources{Compose: true})
	if err := m.Do(context.Background(), "restart", "dapr_placement"); !errors.Is(err, ErrUnknownService) {
		t.Fatalf("Do must reject a filtered-out init service, got %v", err)
	}
	if _, err := m.LogStream(context.Background(), "dapr_scheduler"); !errors.Is(err, ErrUnknownService) {
		t.Fatalf("LogStream must reject a filtered-out init service, got %v", err)
	}
}
