//go:build unit

package workflow

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// fakeStore is an in-memory statestore.Store for unit tests.
type fakeStore struct{ kv map[string][]byte }

func newFakeStore() *fakeStore { return &fakeStore{kv: map[string][]byte{}} }

func (f *fakeStore) Keys(_ context.Context, pattern, _ string, _ int) ([]string, string, error) {
	parts := strings.Split(pattern, "%")
	for i, p := range parts {
		parts[i] = regexp.QuoteMeta(p)
	}
	re := regexp.MustCompile("^" + strings.Join(parts, ".*") + "$")
	var out []string
	for k := range f.kv {
		if re.MatchString(k) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out, "", nil
}
func (f *fakeStore) Get(_ context.Context, key string) ([]byte, error) { return f.kv[key], nil }
func (f *fakeStore) BulkGet(_ context.Context, keys []string) (map[string][]byte, error) {
	m := map[string][]byte{}
	for _, k := range keys {
		m[k] = f.kv[k]
	}
	return m, nil
}
func (f *fakeStore) Delete(_ context.Context, key string) error      { delete(f.kv, key); return nil }
func (f *fakeStore) Set(_ context.Context, k string, v []byte) error { f.kv[k] = v; return nil }
func (f *fakeStore) Close() error                                    { return nil }

// seedWorkflow writes metadata + history-* keys for one instance into the fake store.
func seedWorkflow(t *testing.T, f *fakeStore, ns, appID, instanceID, name string, events []*protos.HistoryEvent) {
	t.Helper()
	prefix := statestore.InstancePrefix(ns, appID, instanceID)
	f.kv[prefix+statestore.SuffixMetadata] = []byte(`{}`)
	for i, e := range events {
		b, err := proto.Marshal(e)
		require.NoError(t, err)
		f.kv[prefix+statestore.HistoryPrefix+pad6(i)] = b
	}
}

func pad6(i int) string {
	s := "000000" + itoa(i)
	return s[len(s)-6:]
}
func itoa(i int) string { // tiny helper to avoid strconv import noise in the test
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

func startedEvent(name string) *protos.HistoryEvent {
	return &protos.HistoryEvent{EventId: 0, Timestamp: timestamppb.Now(), EventType: &protos.HistoryEvent_ExecutionStarted{
		ExecutionStarted: &protos.ExecutionStartedEvent{Name: name, Input: &wrapperspb.StringValue{Value: `{}`}},
	}}
}

func TestServiceListAndFilter(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "inst-a", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
	seedWorkflow(t, f, "default", "order", "inst-b", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})

	svc := New(f, "default")

	res, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 2)
	require.Equal(t, StatusRunning, res.Items[0].Status)

	// search narrows to one
	res, err = svc.List(context.Background(), ListQuery{Search: "inst-a"})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "inst-a", res.Items[0].InstanceID)

	// status filter that matches nothing
	res, err = svc.List(context.Background(), ListQuery{Status: []Status{StatusCompleted}})
	require.NoError(t, err)
	require.Empty(t, res.Items)
}

func TestServiceListNoStore(t *testing.T) {
	svc := New(nil, "default")
	_, err := svc.List(context.Background(), ListQuery{})
	require.ErrorIs(t, err, ErrNoStore)
}

func TestServiceAppIDs(t *testing.T) {
	f := newFakeStore()
	// Two instances under one app, one under another — AppIDs must dedupe and sort.
	seedWorkflow(t, f, "default", "order", "i1", "OrderWorkflow", nil)
	seedWorkflow(t, f, "default", "order", "i2", "OrderWorkflow", nil)
	seedWorkflow(t, f, "default", "pr-digest", "i3", "AgentRunWorkflow", nil)
	svc := New(f, "default")

	ids, err := svc.AppIDs(context.Background())
	require.NoError(t, err)
	require.Equal(t, []string{"order", "pr-digest"}, ids)
}

func TestServiceAppIDsEmptyStore(t *testing.T) {
	svc := New(newFakeStore(), "default")
	ids, err := svc.AppIDs(context.Background())
	require.NoError(t, err)
	require.Empty(t, ids)
}

func TestServiceAppIDsNoStore(t *testing.T) {
	svc := New(nil, "default")
	_, err := svc.AppIDs(context.Background())
	require.ErrorIs(t, err, ErrNoStore)
}

func TestServiceGetDetail(t *testing.T) {
	f := newFakeStore()
	completed := &protos.HistoryEvent{EventId: 1, Timestamp: timestamppb.Now(), EventType: &protos.HistoryEvent_ExecutionCompleted{
		ExecutionCompleted: &protos.ExecutionCompletedEvent{
			WorkflowStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			Result:         &wrapperspb.StringValue{Value: `"ok"`},
		},
	}}
	seedWorkflow(t, f, "default", "order", "inst-c", "OrderWorkflow",
		[]*protos.HistoryEvent{startedEvent("OrderWorkflow"), completed})

	svc := New(f, "default")
	ex, err := svc.Get(context.Background(), "order", "inst-c")
	require.NoError(t, err)
	require.Equal(t, StatusCompleted, ex.Status)
	require.Len(t, ex.History, 2)
	require.NotNil(t, ex.Output)
	require.Equal(t, `"ok"`, *ex.Output)

	_, err = svc.Get(context.Background(), "order", "missing")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestServiceStats(t *testing.T) {
	f := newFakeStore()
	// two Running (started only)
	seedWorkflow(t, f, "default", "order", "inst-a", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
	seedWorkflow(t, f, "default", "order", "inst-b", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
	// one Completed
	completed := &protos.HistoryEvent{EventId: 1, Timestamp: timestamppb.Now(), EventType: &protos.HistoryEvent_ExecutionCompleted{
		ExecutionCompleted: &protos.ExecutionCompletedEvent{
			WorkflowStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			Result:         &wrapperspb.StringValue{Value: `"ok"`},
		},
	}}
	seedWorkflow(t, f, "default", "order", "inst-c", "OrderWorkflow",
		[]*protos.HistoryEvent{startedEvent("OrderWorkflow"), completed})

	svc := New(f, "default")

	// A status filter must NOT affect counts: every status is still tallied.
	res, err := svc.Stats(context.Background(), ListQuery{Status: []Status{StatusCompleted}})
	require.NoError(t, err)
	require.Equal(t, 2, res.Counts[StatusRunning])
	require.Equal(t, 1, res.Counts[StatusCompleted])
	require.Equal(t, 3, res.Total)

	// Search narrows the tally (honored), still ignoring status.
	res, err = svc.Stats(context.Background(), ListQuery{Search: "inst-c"})
	require.NoError(t, err)
	require.Equal(t, 1, res.Total)
	require.Equal(t, 1, res.Counts[StatusCompleted])
	require.Equal(t, 0, res.Counts[StatusRunning])
}

func TestServiceStatsNoStore(t *testing.T) {
	svc := New(nil, "default")
	_, err := svc.Stats(context.Background(), ListQuery{})
	require.ErrorIs(t, err, ErrNoStore)
}

func childStartedEvent(name, parentInstanceID string) *protos.HistoryEvent {
	return &protos.HistoryEvent{EventId: 0, Timestamp: timestamppb.Now(), EventType: &protos.HistoryEvent_ExecutionStarted{
		ExecutionStarted: &protos.ExecutionStartedEvent{
			Name:           name,
			ParentInstance: &protos.ParentInstanceInfo{WorkflowInstance: &protos.WorkflowInstance{InstanceId: parentInstanceID}},
		},
	}}
}

func TestServiceListExcludesChildren(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "parent-1", "ParentWorkflow", []*protos.HistoryEvent{startedEvent("ParentWorkflow")})
	seedWorkflow(t, f, "default", "order", "child-1", "ChildWorkflow", []*protos.HistoryEvent{childStartedEvent("ChildWorkflow", "parent-1")})
	svc := New(f, "default")

	all, err := svc.List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, all.Items, 2)

	topOnly, err := svc.List(context.Background(), ListQuery{IncludeChildren: false})
	require.NoError(t, err)
	require.Len(t, topOnly.Items, 1)
	require.Equal(t, "parent-1", topOnly.Items[0].InstanceID)
}

func TestServiceStatsExcludesChildren(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "parent-1", "ParentWorkflow", []*protos.HistoryEvent{startedEvent("ParentWorkflow")})
	seedWorkflow(t, f, "default", "order", "child-1", "ChildWorkflow", []*protos.HistoryEvent{childStartedEvent("ChildWorkflow", "parent-1")})
	svc := New(f, "default")

	all, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Equal(t, 2, all.Total)

	topOnly, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: false})
	require.NoError(t, err)
	require.Equal(t, 1, topOnly.Total)
}

// pagingStore wraps fakeStore with real cursor paging on Keys: the token is a
// numeric offset into the sorted key list. It also counts how many Keys calls
// used an instance-metadata pattern, so tests can assert how many key-pages a
// single List call consumed.
type pagingStore struct {
	*fakeStore
	metaKeysCalls int
}

func (p *pagingStore) Keys(ctx context.Context, pattern, token string, pageSize int) ([]string, string, error) {
	if strings.HasSuffix(pattern, statestore.KeyDelimiter+statestore.SuffixMetadata) {
		p.metaKeysCalls++
	}
	all, _, err := p.fakeStore.Keys(ctx, pattern, "", 0)
	if err != nil {
		return nil, "", err
	}
	start := 0
	if token != "" {
		start, err = strconv.Atoi(token)
		if err != nil {
			return nil, "", err
		}
	}
	if start > len(all) {
		start = len(all)
	}
	if pageSize <= 0 || start+pageSize >= len(all) {
		return all[start:], "", nil
	}
	end := start + pageSize
	return all[start:end], strconv.Itoa(end), nil
}

// completedEvent finishes a workflow so it decodes as StatusCompleted.
func completedEvent() *protos.HistoryEvent {
	return &protos.HistoryEvent{EventId: 1, Timestamp: timestamppb.Now(), EventType: &protos.HistoryEvent_ExecutionCompleted{
		ExecutionCompleted: &protos.ExecutionCompletedEvent{
			WorkflowStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			Result:         &wrapperspb.StringValue{Value: `"ok"`},
		},
	}}
}

// A status filter with matches spread across several store key-pages must
// still yield a full page of matches from a single List call (loop-fill).
func TestServiceListFilterFillsPageAcrossKeyPages(t *testing.T) {
	p := &pagingStore{fakeStore: newFakeStore()}
	// Alternate Completed / Running: inst-0,2,4 Completed; inst-1,3,5 Running.
	for i := 0; i < 6; i++ {
		events := []*protos.HistoryEvent{startedEvent("W")}
		if i%2 == 0 {
			events = append(events, completedEvent())
		}
		seedWorkflow(t, p.fakeStore, "default", "order", "inst-"+itoa(i), "W", events)
	}
	svc := New(p, "default")

	// pageSize 3: the first key-page (inst-0..2) holds only 2 Completed
	// matches, so List must fetch the next key-page to fill the page.
	res, err := svc.List(context.Background(), ListQuery{
		Status:          []Status{StatusCompleted},
		PageSize:        3,
		IncludeChildren: true,
	})
	require.NoError(t, err)
	require.Len(t, res.Items, 3, "filtered page must be filled across key-pages")
	for _, it := range res.Items {
		require.Equal(t, StatusCompleted, it.Status)
	}
	// Keys were exhausted while filling, so paging is complete.
	require.Empty(t, res.NextToken)
	require.Equal(t, 2, p.metaKeysCalls)
}

// When the last fetched key-page yields more matches than needed to fill the
// page, every accumulated match must be returned: the NextToken has already
// advanced past their keys, so truncating would drop them from paging forever.
func TestServiceListFilterKeepsOvershootMatches(t *testing.T) {
	p := &pagingStore{fakeStore: newFakeStore()}
	// Completed: inst-0,1,3,4,5. Running: inst-2.
	for i := 0; i < 6; i++ {
		events := []*protos.HistoryEvent{startedEvent("W")}
		if i != 2 {
			events = append(events, completedEvent())
		}
		seedWorkflow(t, p.fakeStore, "default", "order", "inst-"+itoa(i), "W", events)
	}
	svc := New(p, "default")

	// pageSize 3: key-page 1 (inst-0..2) yields 2 matches, key-page 2
	// (inst-3..5) yields 3 more — 5 total, token now exhausted.
	res, err := svc.List(context.Background(), ListQuery{
		Status:          []Status{StatusCompleted},
		PageSize:        3,
		IncludeChildren: true,
	})
	require.NoError(t, err)
	require.Len(t, res.Items, 5, "matches from fully-scanned key-pages must not be truncated away")
	require.Empty(t, res.NextToken)
}

// A filter matching nothing must exhaust the keyspace and return empty items
// with an empty token — not an empty page with a token the client must chase.
func TestServiceListFilterNoMatchesExhaustsKeys(t *testing.T) {
	p := &pagingStore{fakeStore: newFakeStore()}
	for i := 0; i < 5; i++ {
		seedWorkflow(t, p.fakeStore, "default", "order", "inst-"+itoa(i), "W",
			[]*protos.HistoryEvent{startedEvent("W")})
	}
	svc := New(p, "default")

	res, err := svc.List(context.Background(), ListQuery{
		Status:          []Status{StatusFailed},
		PageSize:        2,
		IncludeChildren: true,
	})
	require.NoError(t, err)
	require.Empty(t, res.Items)
	require.Empty(t, res.NextToken, "exhausted keyspace must end paging")
	require.Equal(t, 3, p.metaKeysCalls, "must scan all key-pages before giving up")
}

// On a huge keyspace where the filter matches nothing, the scan cap must stop
// the loop early and return a non-empty token so the client can continue.
func TestServiceListFilterScanCapStopsEarly(t *testing.T) {
	p := &pagingStore{fakeStore: newFakeStore()}
	// 30 Running instances; cap for pageSize 2 is 10*2 = 20 keys.
	for i := 0; i < 30; i++ {
		seedWorkflow(t, p.fakeStore, "default", "order", "inst-"+pad6(i), "W",
			[]*protos.HistoryEvent{startedEvent("W")})
	}
	svc := New(p, "default")

	res, err := svc.List(context.Background(), ListQuery{
		Status:          []Status{StatusFailed},
		PageSize:        2,
		IncludeChildren: true,
	})
	require.NoError(t, err)
	require.Empty(t, res.Items)
	require.NotEmpty(t, res.NextToken, "cap hit before exhaustion must return a resume token")
	require.Equal(t, 10, p.metaKeysCalls, "must stop at the 10x-pageSize scan cap")
}

// Without filters, List must keep its one-key-page-per-call behavior: a single
// Keys call, pageSize items, and the store's token passed through.
func TestServiceListUnfilteredSinglePageUnchanged(t *testing.T) {
	p := &pagingStore{fakeStore: newFakeStore()}
	for i := 0; i < 6; i++ {
		seedWorkflow(t, p.fakeStore, "default", "order", "inst-"+itoa(i), "W",
			[]*protos.HistoryEvent{startedEvent("W")})
	}
	svc := New(p, "default")

	res, err := svc.List(context.Background(), ListQuery{PageSize: 2, IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 2)
	require.Equal(t, "2", res.NextToken, "store token must pass through unchanged")
	require.Equal(t, 1, p.metaKeysCalls, "unfiltered list must fetch exactly one key-page")

	// Second page resumes from the returned token.
	res2, err := svc.List(context.Background(), ListQuery{PageSize: 2, PageToken: res.NextToken, IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res2.Items, 2)
	require.Equal(t, "4", res2.NextToken)
}

func TestServiceListEnumeratesAllAppIDsFromStore(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "i1", "OrderWorkflow", nil)
	seedWorkflow(t, f, "default", "pr-digest", "i2", "AgentRunWorkflow", nil)
	svc := New(f, "default")

	// No app filter: both app-ids' instances appear, even though neither was
	// supplied by a running-apps list.
	res, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err)
	got := map[string]bool{}
	for _, it := range res.Items {
		got[it.AppID] = true
	}
	require.True(t, got["order"], "order instance must be listed")
	require.True(t, got["pr-digest"], "pr-digest instance must be listed")

	// Scoped to one app: only that app's instances.
	scoped, err := svc.List(context.Background(), ListQuery{AppID: "pr-digest"})
	require.NoError(t, err)
	require.Len(t, scoped.Items, 1)
	require.Equal(t, "pr-digest", scoped.Items[0].AppID)

	// Stats across all app-ids counts both.
	stats, err := svc.Stats(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Equal(t, 2, stats.Total)
}
