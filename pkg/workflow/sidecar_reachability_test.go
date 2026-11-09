//go:build unit

package workflow

import (
	"context"
	"testing"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
)

// endpoints builds an EndpointsFunc over a fixed slice.
func endpoints(eps ...SidecarEndpoint) EndpointsFunc {
	return func(context.Context) []SidecarEndpoint { return eps }
}

func completedHub(id string) *fakeHub {
	return &fakeHub{
		pages:  [][]string{{id}},
		states: map[string]*protos.WorkflowState{id: wfState(id, "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "")},
	}
}

// A sidecar discovery already knows is unreachable is never dialed for the
// all-apps reads, so a stopped app costs nothing (it used to cost the full
// per-app timeout on every list, stats and app-id request).
func TestSidecar_UnreachableEndpointSkippedWithoutDialing(t *testing.T) {
	live := startFakeHub(t, completedHub("w1"))
	wedged := startFakeHub(t, &fakeHub{block: true})
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(endpoints(
		SidecarEndpoint{AppID: "live", Addr: live},
		SidecarEndpoint{AppID: "down", Addr: wedged, Unreachable: true},
	))
	ctx := context.Background()

	start := time.Now()
	res, err := svc.List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "live", res.Items[0].AppID)

	ids, err := svc.AppIDs(ctx)
	require.NoError(t, err)
	require.Equal(t, []string{"live"}, ids)
	require.Less(t, time.Since(start), time.Second, "an unreachable sidecar must not be dialed")

	// Still owned (app-scoped reads route here) but answered at once.
	require.True(t, svc.Owns(ctx, "down"))
	start = time.Now()
	_, err = svc.Get(ctx, "down", "x")
	require.ErrorIs(t, err, ErrSidecarUnreachable)
	_, err = svc.listOwned(ctx, ListQuery{AppID: "down"})
	require.ErrorIs(t, err, ErrSidecarUnreachable)
	require.Less(t, time.Since(start), time.Second)
}

// Reachable-but-wedged sidecars are queried in parallel, so N of them cost
// one timeout, not N.
func TestSidecarList_FansOutInParallel(t *testing.T) {
	orig := sidecarCallTimeout
	sidecarCallTimeout = 400 * time.Millisecond
	t.Cleanup(func() { sidecarCallTimeout = orig })
	a := startFakeHub(t, &fakeHub{block: true})
	b := startFakeHub(t, &fakeHub{block: true})
	c := startFakeHub(t, &fakeHub{block: true})
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(endpoints(
		SidecarEndpoint{AppID: "a", Addr: a},
		SidecarEndpoint{AppID: "b", Addr: b},
		SidecarEndpoint{AppID: "c", Addr: c},
	))

	start := time.Now()
	_, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err)
	_, err = svc.AppIDs(context.Background())
	require.NoError(t, err)
	// Sequential would be 3 x 400ms per call; parallel is ~400ms per call.
	require.Less(t, time.Since(start), 1100*time.Millisecond)
}

// A sidecar that times out surfaces as ErrSidecarUnreachable (a readable 503
// at the API), not a raw "context deadline exceeded".
func TestSidecarGet_TimeoutIsUnreachable(t *testing.T) {
	withShortSidecarTimeout(t)
	addr := startFakeHub(t, &fakeHub{block: true})
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("wedged-app", addr))

	_, err := svc.Get(context.Background(), "wedged-app", "x")
	require.ErrorIs(t, err, ErrSidecarUnreachable)
	require.Contains(t, err.Error(), "wedged-app")
}
