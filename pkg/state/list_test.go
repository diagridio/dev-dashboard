//go:build unit

package state

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func seedApp(f *fakeStore, app string, n int) {
	for i := 0; i < n; i++ {
		f.set(fmt.Sprintf("%s||order-%03d", app, i), fmt.Sprintf(`{"id":%d}`, i))
	}
}

func TestListDefaultsToAppRecordsOnly(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||order-1", `{"id":1}`)
	f.set("myapp||dapr.internal.default.myapp.workflow||i1||metadata", "wf")
	f.set("myapp||MyActor||a1||balance", "42")
	svc := New(f, f)

	res, err := svc.List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "myapp||order-1", res.Items[0].Key)
	require.Equal(t, "order-1", res.Items[0].LogicalKey)
	require.Equal(t, "myapp", res.Items[0].AppID)
	require.Equal(t, KindApp, res.Items[0].Kind)
	require.Equal(t, `{"id":1}`, res.Items[0].Preview)
	require.Equal(t, EncodingText, res.Items[0].Encoding)
	require.Equal(t, len(`{"id":1}`), res.Items[0].Size)

	t.Run("IncludeInternal reveals workflow and actor keys", func(t *testing.T) {
		res, err := svc.List(ctx, ListQuery{IncludeInternal: true})
		require.NoError(t, err)
		require.Len(t, res.Items, 3)
	})
}

func TestListPushesFiltersIntoThePattern(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||order-1", "a")
	f.set("other||order-2", "b")
	f.set("myapp||invoice-9", "c")
	svc := New(f, f)

	res, err := svc.List(ctx, ListQuery{AppID: "myapp"})
	require.NoError(t, err)
	require.Len(t, res.Items, 2)
	require.Equal(t, "myapp||%", f.patterns[0])

	f.patterns = nil
	res, err = svc.List(ctx, ListQuery{AppID: "myapp", Search: "order"})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "myapp||%order%", f.patterns[0])
}

func TestListSearchMetacharactersMatchLiterally(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||order_42", "underscore")
	f.set("myapp||order-42", "hyphen")
	svc := New(f, f)

	res, err := svc.List(ctx, ListQuery{Search: "order_42"})
	require.NoError(t, err)
	require.Len(t, res.Items, 1, "the underscore must not act as a single-character wildcard")
	require.Equal(t, "myapp||order_42", res.Items[0].Key)
}

func TestListReadsValuesOnceForTheReturnedPageOnly(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	seedApp(f, "myapp", 5)
	// A pile of workflow keys that must cost only key bytes to skip.
	for i := 0; i < 40; i++ {
		f.set(fmt.Sprintf("myapp||dapr.internal.default.myapp.workflow||i%02d||metadata", i), "wf")
	}
	svc := New(f, f)

	res, err := svc.List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 5)
	require.Equal(t, 1, f.recordCalls, "exactly one bulk value read per List")
}

func TestListPaging(t *testing.T) {
	ctx := context.Background()

	t.Run("unfiltered returns one key page per call and a forward token", func(t *testing.T) {
		f := newFakeStore()
		seedApp(f, "myapp", 7)
		svc := New(f, f)

		first, err := svc.List(ctx, ListQuery{PageSize: 3, IncludeInternal: true})
		require.NoError(t, err)
		require.Len(t, first.Items, 3)
		require.NotEmpty(t, first.NextToken)

		second, err := svc.List(ctx, ListQuery{PageSize: 3, IncludeInternal: true, PageToken: first.NextToken})
		require.NoError(t, err)
		require.Len(t, second.Items, 3)
		require.NotEqual(t, first.Items[0].Key, second.Items[0].Key)

		third, err := svc.List(ctx, ListQuery{PageSize: 3, IncludeInternal: true, PageToken: second.NextToken})
		require.NoError(t, err)
		require.Len(t, third.Items, 1)
		require.Empty(t, third.NextToken)
	})

	t.Run("loop-fills a page thinned by the internal-key filter", func(t *testing.T) {
		f := newFakeStore()
		// 10 app keys and 40 internal ones. Keys sort with the app keys first
		// ("a-order-" < "dapr.internal."), so with a 5-key page limit the first
		// two pages are needed to reach a 10-item page — the loop-fill path.
		for i := 0; i < 10; i++ {
			f.set(fmt.Sprintf("myapp||a-order-%02d", i), "v")
			for j := 0; j < 4; j++ {
				f.set(fmt.Sprintf("myapp||dapr.internal.default.myapp.workflow||i%02d-%d||metadata", i, j), "wf")
			}
		}
		f.pageLimit = 5 // each Keys call returns 5 keys regardless of pageSize
		svc := New(f, f)

		res, err := svc.List(ctx, ListQuery{PageSize: 10})
		require.NoError(t, err)
		require.GreaterOrEqual(t, len(res.Items), 10, "loop-fill must reach the page size")
		require.Greater(t, f.keyCalls, 1, "one key page cannot fill a filtered page")
		require.Equal(t, 1, f.recordCalls, "still exactly one bulk value read")
	})

	t.Run("stops at the scan cap and returns a resume token", func(t *testing.T) {
		f := newFakeStore()
		// 3000 internal keys and no app keys: the filter can never fill a page.
		for i := 0; i < 3000; i++ {
			f.set(fmt.Sprintf("myapp||dapr.internal.default.myapp.workflow||i%04d||metadata", i), "wf")
		}
		f.pageLimit = 100
		svc := New(f, f)

		res, err := svc.List(ctx, ListQuery{PageSize: 50})
		require.NoError(t, err)
		require.Empty(t, res.Items)
		require.NotEmpty(t, res.NextToken, "a capped page must still be resumable")
		require.LessOrEqual(t, f.keyCalls, maxFilteredScanKeys/100+1, "the scan must be bounded")
	})
}

func TestListSortsByKeyForStablePaging(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||c", "3")
	f.set("myapp||a", "1")
	f.set("myapp||b", "2")
	res, err := New(f, f).List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Equal(t,
		[]string{"myapp||a", "myapp||b", "myapp||c"},
		[]string{res.Items[0].Key, res.Items[1].Key, res.Items[2].Key})
}

func TestListSurfacesEtagAsVersion(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||order-1", "v")
	f.etags["myapp||order-1"] = "7"
	res, err := New(f, f).List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Equal(t, "7", res.Items[0].ETag)
}

func TestRecordReturnsFullValue(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	big := strings.Repeat("x", 5000)
	f.set("myapp||order-1", big)
	f.etags["myapp||order-1"] = "3"
	svc := New(f, f)

	rec, err := svc.Record(ctx, "myapp||order-1")
	require.NoError(t, err)
	require.Equal(t, big, rec.Value, "the detail read is not preview-truncated")
	require.False(t, rec.Truncated)
	require.Equal(t, 5000, rec.Size)
	require.Equal(t, "3", rec.ETag)
	require.Equal(t, "order-1", rec.LogicalKey)
	require.Equal(t, KindApp, rec.Kind)

	t.Run("missing key reports ErrNotFound", func(t *testing.T) {
		_, err := svc.Record(ctx, "myapp||nope")
		require.ErrorIs(t, err, ErrNotFound)
	})

	t.Run("over-cap value is truncated and flagged", func(t *testing.T) {
		f.set("myapp||huge", strings.Repeat("y", maxValueBytes+100))
		rec, err := svc.Record(ctx, "myapp||huge")
		require.NoError(t, err)
		require.True(t, rec.Truncated)
		require.Len(t, rec.Value, maxValueBytes)
		require.Equal(t, maxValueBytes+100, rec.Size, "Size reports the true length")
	})

	t.Run("internal keys are readable by key even though the list hides them", func(t *testing.T) {
		f.set("myapp||dapr.internal.default.myapp.workflow||i1||metadata", "wf")
		rec, err := svc.Record(ctx, "myapp||dapr.internal.default.myapp.workflow||i1||metadata")
		require.NoError(t, err)
		require.Equal(t, KindWorkflow, rec.Kind)
	})
}
