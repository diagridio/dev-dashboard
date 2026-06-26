//go:build unit

package workflow

import (
	"context"
	"sort"
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
	like := strings.TrimSuffix(pattern, "%") // crude prefix match good enough for tests
	var prefix, suffix string
	if i := strings.Index(pattern, "%"); i >= 0 {
		prefix = pattern[:i]
		suffix = pattern[i+1:]
	} else {
		prefix = pattern
	}
	_ = like
	var out []string
	for k := range f.kv {
		if strings.HasPrefix(k, prefix) && strings.HasSuffix(k, suffix) {
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

	svc := New(f, "default", func(context.Context) ([]string, error) { return []string{"order"}, nil })

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
	svc := New(nil, "default", func(context.Context) ([]string, error) { return []string{"order"}, nil })
	_, err := svc.List(context.Background(), ListQuery{})
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

	svc := New(f, "default", func(context.Context) ([]string, error) { return []string{"order"}, nil })
	ex, err := svc.Get(context.Background(), "order", "inst-c")
	require.NoError(t, err)
	require.Equal(t, StatusCompleted, ex.Status)
	require.Len(t, ex.History, 2)
	require.NotNil(t, ex.Output)
	require.Equal(t, `"ok"`, *ex.Output)

	_, err = svc.Get(context.Background(), "order", "missing")
	require.ErrorIs(t, err, ErrNotFound)
}
