package lifecycle

import (
	"context"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

// fakeApps serves canned instances by key.
type fakeApps struct{ items map[string]discovery.Instance }

func (f fakeApps) List(ctx context.Context) ([]discovery.Instance, error) {
	out := make([]discovery.Instance, 0, len(f.items))
	for _, in := range f.items {
		out = append(out, in)
	}
	return out, nil
}
func (f fakeApps) Get(ctx context.Context, key string) (discovery.Instance, error) {
	if in, ok := f.items[key]; ok {
		return in, nil
	}
	return discovery.Instance{}, discovery.ErrNotFound
}

// fakeRunner records docker invocations.
type fakeRunner struct{ calls [][]string }

func (f *fakeRunner) Run(ctx context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	return nil, nil
}
func (f *fakeRunner) Stream(ctx context.Context, args ...string) (<-chan string, error) {
	return nil, nil
}

func composeInst() discovery.Instance {
	return discovery.Instance{
		AppID: "checkout", InstanceKey: "shop-checkout-app-1",
		Source:         discovery.SourceCompose,
		AppContainerID: "appC", DaprdContainerID: "daprdC",
	}
}

func TestComposeSingleTargetActions(t *testing.T) {
	run := &fakeRunner{}
	m := New(fakeApps{items: map[string]discovery.Instance{"shop-checkout-app-1": composeInst()}},
		NewRegistry(), run, nil, nil)

	require.NoError(t, m.Do(context.Background(), "shop-checkout-app-1", TargetApp, ActionStop))
	require.NoError(t, m.Do(context.Background(), "shop-checkout-app-1", TargetDaprd, ActionRestart))
	require.Equal(t, [][]string{{"stop", "appC"}, {"restart", "daprdC"}}, run.calls)
}

func TestComposeAllOrdering(t *testing.T) {
	run := &fakeRunner{}
	m := New(fakeApps{items: map[string]discovery.Instance{"k": composeInst()}}, NewRegistry(), run, nil, nil)

	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStop))
	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStart))
	require.Equal(t, [][]string{
		{"stop", "appC"}, {"stop", "daprdC"}, // stop: app first
		{"start", "daprdC"}, {"start", "appC"}, // start: sidecar first
	}, run.calls)
}

func TestComposeValidation(t *testing.T) {
	m := New(fakeApps{items: map[string]discovery.Instance{"k": composeInst()}}, NewRegistry(), nil, nil, nil)
	require.ErrorIs(t, m.Do(context.Background(), "k", "bogus", ActionStop), ErrInvalidTarget)
	require.ErrorIs(t, m.Do(context.Background(), "k", TargetApp, "bogus"), ErrInvalidAction)
	require.ErrorIs(t, m.Do(context.Background(), "missing", TargetApp, ActionStop), discovery.ErrNotFound)
	require.ErrorIs(t, m.Do(context.Background(), "k", TargetApp, ActionStop), ErrRuntimeUnavailable) // nil runner

	// unpaired app container
	in := composeInst()
	in.AppContainerID = ""
	run := &fakeRunner{}
	m = New(fakeApps{items: map[string]discovery.Instance{"k": in}}, NewRegistry(), run, nil, nil)
	require.ErrorIs(t, m.Do(context.Background(), "k", TargetApp, ActionStop), ErrUnsupported)
}

func TestComposeAllRestart(t *testing.T) {
	run := &fakeRunner{}
	m := New(fakeApps{items: map[string]discovery.Instance{"k": composeInst()}}, NewRegistry(), run, nil, nil)

	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionRestart))
	require.Equal(t, [][]string{{"restart", "daprdC"}, {"restart", "appC"}}, run.calls)
}

func TestComposeAllPartialContainers(t *testing.T) {
	// Test case 1: sidecar-only instance (empty AppContainerID)
	run := &fakeRunner{}
	inSidecarOnly := composeInst()
	inSidecarOnly.AppContainerID = ""
	m := New(fakeApps{items: map[string]discovery.Instance{"k": inSidecarOnly}}, NewRegistry(), run, nil, nil)

	// TargetAll stop should act on daprd container only
	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStop))
	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStart))
	require.Equal(t, [][]string{{"stop", "daprdC"}, {"start", "daprdC"}}, run.calls)

	// Test case 2: both containers missing
	inBothMissing := composeInst()
	inBothMissing.AppContainerID = ""
	inBothMissing.DaprdContainerID = ""
	runBoth := &fakeRunner{}
	mBoth := New(fakeApps{items: map[string]discovery.Instance{"k": inBothMissing}}, NewRegistry(), runBoth, nil, nil)

	require.ErrorIs(t, mBoth.Do(context.Background(), "k", TargetAll, ActionStop), ErrUnsupported)
}
