//go:build unit

package actors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	runtimev1pb "github.com/dapr/dapr/pkg/proto/runtime/v1"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/state"
)

// svcSched is a gRPC sidecar fake with configurable reminders (per type).
type svcSched struct {
	runtimev1pb.UnimplementedDaprServer
	reminders map[string][]string // actor type -> owning actor ids, one reminder each
	timers    map[string][]string // actor id -> timer names

	mu       sync.Mutex
	remTypes []string
}

func (f *svcSched) ListActorReminders(_ context.Context, req *runtimev1pb.ListActorRemindersRequest) (*runtimev1pb.ListActorRemindersResponse, error) {
	f.mu.Lock()
	f.remTypes = append(f.remTypes, req.GetActorType())
	f.mu.Unlock()
	out := &runtimev1pb.ListActorRemindersResponse{}
	for i, id := range f.reminders[req.GetActorType()] {
		if req.ActorId != nil && req.GetActorId() != id {
			continue
		}
		out.Reminders = append(out.Reminders, &runtimev1pb.NamedActorReminder{
			Name:     fmt.Sprintf("r%d", i),
			Reminder: &runtimev1pb.ActorReminder{ActorType: req.GetActorType(), ActorId: id},
		})
	}
	return out, nil
}

func (f *svcSched) ListActorTimers(_ context.Context, req *runtimev1pb.ListActorTimersRequest) (*runtimev1pb.ListActorTimersResponse, error) {
	out := &runtimev1pb.ListActorTimersResponse{}
	for _, n := range f.timers[req.GetActorId()] {
		out.Timers = append(out.Timers, &runtimev1pb.NamedActorTimer{Name: n, Timer: &runtimev1pb.ActorTimer{ActorId: req.GetActorId()}})
	}
	return out, nil
}

func (f *svcSched) types() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.remTypes...)
}

type svcApps struct{ instances []discovery.Instance }

func (a *svcApps) List(context.Context) ([]discovery.Instance, error) { return a.instances, nil }
func (a *svcApps) Get(_ context.Context, key string) (discovery.Instance, error) {
	for _, in := range a.instances {
		if in.InstanceKey == key {
			return in, nil
		}
	}
	for _, in := range a.instances {
		if in.AppID == key {
			return in, nil
		}
	}
	return discovery.Instance{}, fmt.Errorf("%w: %s", discovery.ErrNotFound, key)
}

// fakeStore pages items PageSize at a time; endless keeps returning a token.
type fakeStore struct {
	items   []state.Item
	endless bool

	mu      sync.Mutex
	queries []state.ListQuery
}

func (f *fakeStore) List(_ context.Context, q state.ListQuery) (state.ListResult, error) {
	f.mu.Lock()
	f.queries = append(f.queries, q)
	f.mu.Unlock()
	if f.endless {
		items := make([]state.Item, q.PageSize)
		for i := range items {
			items[i] = state.Item{LogicalKey: fmt.Sprintf("Deck||d%s-%d||k", q.PageToken, i)}
		}
		return state.ListResult{Items: items, NextToken: q.PageToken + "x"}, nil
	}
	var out []state.Item
	for _, it := range f.items {
		if strings.Contains(it.LogicalKey, q.Search) {
			out = append(out, it)
		}
	}
	return state.ListResult{Items: out}, nil
}
func (f *fakeStore) Record(context.Context, string) (state.Record, error) { return state.Record{}, nil }
func (f *fakeStore) AppIDs(context.Context, bool) ([]string, error)       { return nil, nil }
func (f *fakeStore) Delete(context.Context, []string) []state.DeleteResult {
	return nil
}
func (f *fakeStore) Set(context.Context, state.SetRequest) error { return nil }

// configApp serves body at /dapr/config and returns its port.
func configApp(t *testing.T, body string) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/dapr/config" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	p, _ := strconv.Atoi(u.Port())
	return p
}

func newTestService(t *testing.T, sched *svcSched, store *fakeStore, resolved func(discovery.Instance) (string, string, bool), mk func(base discovery.Instance) []discovery.Instance) *Service {
	t.Helper()
	base, conns := startSched(t, sched)
	apps := &svcApps{instances: mk(base)}
	stateFor := func(id string) (state.Service, bool) {
		if store == nil || id != "store-1" {
			return nil, false
		}
		return store, true
	}
	if resolved == nil {
		resolved = func(discovery.Instance) (string, string, bool) { return "store-1", "statestore", true }
	}
	return NewService(apps, conns, NewConfigReader(http.DefaultClient, time.Minute), stateFor, resolved, http.DefaultClient)
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestActorsListIncludesConfigAndReminders(t *testing.T) {
	port := configApp(t, `{"entities":["Deck"],"actorIdleTimeout":"5m"}`)
	sched := &svcSched{reminders: map[string][]string{"Deck": {"d1", "d2"}}}
	svc := newTestService(t, sched, nil, nil, func(b discovery.Instance) []discovery.Instance {
		b.InstanceKey, b.AppPort = "orders-1", port
		b.Placement, b.ActorRuntimeStatus, b.ActorHostReady = "placement: connected", "RUNNING", true
		b.Actors = []discovery.ActorType{{Type: "Deck", Count: 3}}
		other := discovery.Instance{AppID: "other", InstanceKey: "other", Actors: []discovery.ActorType{{Type: "Cart"}}}
		return []discovery.Instance{b, other}
	})
	rows, err := svc.List(context.Background(), "orders")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 row (appId filter), got %+v", rows)
	}
	r := rows[0]
	if r.Config == nil || r.Config.IdleTimeout != "5m" || r.ConfigUnavailable != nil {
		t.Fatalf("config: %+v %+v", r.Config, r.ConfigUnavailable)
	}
	if r.Reminders == nil || *r.Reminders != 2 || r.RemindersUnavailable != nil {
		t.Fatalf("reminders: %v %+v", r.Reminders, r.RemindersUnavailable)
	}
	js := mustJSON(t, r)
	for _, want := range []string{`"appId":"orders"`, `"instanceKey":"orders-1"`, `"type":"Deck"`, `"count":3`, `"idleTimeout":"5m"`, `"reminders":2`, `"placement":"placement: connected"`, `"runtimeStatus":"RUNNING"`, `"hostReady":true`, `"internal":false`} {
		if !strings.Contains(js, want) {
			t.Errorf("missing %s in %s", want, js)
		}
	}
}

func TestActorsListReasons(t *testing.T) {
	sched := &svcSched{reminders: map[string][]string{"Deck": {"d1"}}}
	svc := newTestService(t, sched, nil, nil, func(b discovery.Instance) []discovery.Instance {
		old := b
		old.AppID, old.InstanceKey, old.RuntimeVersion, old.AppProtocol = "old", "old", "1.16.0", "grpc"
		old.Actors = []discovery.ActorType{{Type: "Deck", Count: 1}}
		cur := b
		cur.AppID, cur.InstanceKey, cur.AppProtocol = "cur", "cur", "grpc"
		cur.Actors = []discovery.ActorType{{Type: "dapr.internal.default.cur.workflow", Count: 1}}
		return []discovery.Instance{old, cur}
	})
	rows, err := svc.List(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("rows: %+v", rows)
	}
	byApp := map[string]TypeRow{}
	for _, r := range rows {
		byApp[r.AppID] = r
	}
	old := byApp["old"]
	if old.ConfigUnavailable == nil || old.ConfigUnavailable.Reason != "gRPC app: no /dapr/config" || old.Config != nil {
		t.Errorf("config reason: %+v", old.ConfigUnavailable)
	}
	if old.RemindersUnavailable == nil || old.RemindersUnavailable.Reason != "requires Dapr 1.17+" || old.Reminders != nil {
		t.Errorf("reminders reason: %+v", old.RemindersUnavailable)
	}
	cur := byApp["cur"]
	if !cur.Internal || cur.Reminders != nil || cur.RemindersUnavailable != nil {
		t.Errorf("internal row: %+v", cur)
	}
	if cur.ConfigUnavailable == nil {
		t.Errorf("internal row still reads config: %+v", cur)
	}
	for _, typ := range sched.types() {
		if IsInternal(typ) {
			t.Errorf("reminders called for internal type %s", typ)
		}
	}
}

func TestActorTypeMergesIDs(t *testing.T) {
	sched := &svcSched{reminders: map[string][]string{"Deck": {"d3"}}}
	store := &fakeStore{items: []state.Item{
		{LogicalKey: "Deck||d1||cards"},
		{LogicalKey: "Deck||d1||owner"},
		{LogicalKey: "DeckX||d9||cards"},
	}}
	svc := newTestService(t, sched, store, nil, func(b discovery.Instance) []discovery.Instance {
		b.InstanceKey = "orders-1"
		b.Actors = []discovery.ActorType{{Type: "Deck", Count: 1}}
		return []discovery.Instance{b}
	})
	d, err := svc.Type(context.Background(), "orders-1", "Deck")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.IDs) != 2 || d.IDs[0].ID != "d1" || d.IDs[0].StateKeys != 2 || d.IDs[1].ID != "d3" || d.IDs[1].Reminders != 1 {
		t.Fatalf("ids: %+v", d.IDs)
	}
	if strings.Join(d.IDs[0].Sources, ",") != "state" || strings.Join(d.IDs[1].Sources, ",") != "reminders" {
		t.Fatalf("sources: %+v", d.IDs)
	}
	if d.Truncated || d.StateUnavailable != nil || d.Reminders == nil || *d.Reminders != 1 {
		t.Fatalf("detail: %+v", d)
	}
	q := store.queries[0]
	if q.AppID != "orders" || q.Search != "Deck||" || !q.IncludeInternal || q.PageSize != 500 {
		t.Fatalf("query: %+v", q)
	}
}

func TestActorTypeNoStore(t *testing.T) {
	sched := &svcSched{reminders: map[string][]string{"Deck": {"d3"}}}
	resolve := func(discovery.Instance) (string, string, bool) { return "", "statestore", false }
	svc := newTestService(t, sched, &fakeStore{}, resolve, func(b discovery.Instance) []discovery.Instance {
		b.Actors = []discovery.ActorType{{Type: "Deck", Count: 1}}
		return []discovery.Instance{b}
	})
	d, err := svc.Type(context.Background(), "orders", "Deck")
	if err != nil {
		t.Fatal(err)
	}
	if d.StateUnavailable == nil || d.StateUnavailable.Reason != "This app's actor state store (statestore) isn't connected" {
		t.Fatalf("state reason: %+v", d.StateUnavailable)
	}
	if len(d.IDs) != 1 || d.IDs[0].ID != "d3" {
		t.Fatalf("ids: %+v", d.IDs)
	}
}

func TestActorTypeTruncated(t *testing.T) {
	store := &fakeStore{endless: true}
	svc := newTestService(t, &svcSched{}, store, nil, func(b discovery.Instance) []discovery.Instance {
		b.Actors = []discovery.ActorType{{Type: "Deck", Count: 1}}
		return []discovery.Instance{b}
	})
	d, err := svc.Type(context.Background(), "orders", "Deck")
	if err != nil {
		t.Fatal(err)
	}
	if !d.Truncated {
		t.Fatal("want truncated")
	}
	if n := len(store.queries); n != 4 {
		t.Fatalf("want 4 pages (2000 keys), got %d", n)
	}
	if !strings.Contains(mustJSON(t, d), `"truncated":true`) {
		t.Fatal("json missing truncated")
	}
}

func TestActorDetailSectionsIndependent(t *testing.T) {
	sched := &svcSched{reminders: map[string][]string{"Deck": {"d1", "d2"}}}
	resolve := func(discovery.Instance) (string, string, bool) { return "", "", false }
	svc := newTestService(t, sched, nil, resolve, func(b discovery.Instance) []discovery.Instance {
		b.RuntimeVersion = "1.18.0"
		b.Actors = []discovery.ActorType{{Type: "Deck", Count: 1}}
		return []discovery.Instance{b}
	})
	d, err := svc.Actor(context.Background(), "orders", "Deck", "d1")
	if err != nil {
		t.Fatal(err)
	}
	if d.StateUnavailable == nil || d.StateUnavailable.Reason != "No state store found for this app" {
		t.Errorf("state: %+v", d.StateUnavailable)
	}
	if d.TimersUnavailable == nil || d.TimersUnavailable.Reason != "requires Dapr 1.19+" {
		t.Errorf("timers: %+v", d.TimersUnavailable)
	}
	if d.RemindersUnavailable != nil || len(d.Reminders) != 1 || d.Reminders[0].ActorID != "d1" {
		t.Errorf("reminders: %+v %+v", d.Reminders, d.RemindersUnavailable)
	}
	js := mustJSON(t, d)
	if !strings.Contains(js, `"state":[]`) || !strings.Contains(js, `"timers":[]`) {
		t.Errorf("empty sections must be []: %s", js)
	}
}

func TestActorDetailState(t *testing.T) {
	sched := &svcSched{timers: map[string][]string{"d1": {"tick"}}}
	store := &fakeStore{items: []state.Item{{LogicalKey: "Deck||d1||cards"}, {LogicalKey: "Deck||d10||cards"}}}
	svc := newTestService(t, sched, store, nil, func(b discovery.Instance) []discovery.Instance {
		b.Actors = []discovery.ActorType{{Type: "Deck", Count: 1}}
		return []discovery.Instance{b}
	})
	d, err := svc.Actor(context.Background(), "orders", "Deck", "d1")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.State) != 1 || d.State[0].LogicalKey != "Deck||d1||cards" || d.StoreID != "store-1" {
		t.Fatalf("state: %+v store %q", d.State, d.StoreID)
	}
	if store.queries[0].Search != "Deck||d1||" {
		t.Fatalf("search: %q", store.queries[0].Search)
	}
	if len(d.Timers) != 1 || d.Timers[0].Name != "tick" || d.TimersUnavailable != nil {
		t.Fatalf("timers: %+v %+v", d.Timers, d.TimersUnavailable)
	}
}

func TestServiceInvokeValidation(t *testing.T) {
	svc := newTestService(t, &svcSched{}, nil, nil, func(b discovery.Instance) []discovery.Instance { return []discovery.Instance{b} })
	ctx := context.Background()
	if _, err := svc.Invoke(ctx, "orders", "dapr.internal.x", "a", InvokeRequest{Method: "m"}); err != ErrInternalType {
		t.Errorf("internal: %v", err)
	}
	if _, err := svc.Invoke(ctx, "orders", "Deck", "", InvokeRequest{Method: "m"}); !isInvalid(err) {
		t.Errorf("empty id: %v", err)
	}
	if _, err := svc.Invoke(ctx, "orders", "Deck", "a", InvokeRequest{}); !isInvalid(err) {
		t.Errorf("empty method: %v", err)
	}
	if _, err := svc.Invoke(ctx, "nope", "Deck", "a", InvokeRequest{Method: "m"}); !isNotFound(err) {
		t.Errorf("unknown app: %v", err)
	}
	if err := svc.DeleteReminder(ctx, "orders", "dapr.internal.x", "a", "r"); err != ErrInternalType {
		t.Errorf("delete internal: %v", err)
	}
	if err := svc.DeleteReminder(ctx, "orders", "Deck", "a", ""); !isInvalid(err) {
		t.Errorf("delete empty name: %v", err)
	}
}

func isInvalid(err error) bool  { return errors.Is(err, ErrInvalidRequest) }
func isNotFound(err error) bool { return errors.Is(err, discovery.ErrNotFound) }

func TestActorDetailStateTruncated(t *testing.T) {
	store := &fakeStore{endless: true}
	svc := newTestService(t, &svcSched{}, store, nil, func(b discovery.Instance) []discovery.Instance {
		b.Actors = []discovery.ActorType{{Type: "Deck", Count: 1}}
		return []discovery.Instance{b}
	})
	d, err := svc.Actor(context.Background(), "orders", "Deck", "d1")
	if err != nil {
		t.Fatal(err)
	}
	if !d.StateTruncated {
		t.Fatal("want stateTruncated")
	}
	if !strings.Contains(mustJSON(t, d), `"stateTruncated":true`) {
		t.Fatal("json missing stateTruncated")
	}

	d, err = newTestService(t, &svcSched{}, &fakeStore{}, nil, func(b discovery.Instance) []discovery.Instance {
		b.Actors = []discovery.ActorType{{Type: "Deck", Count: 1}}
		return []discovery.Instance{b}
	}).Actor(context.Background(), "orders", "Deck", "d1")
	if err != nil {
		t.Fatal(err)
	}
	if d.StateTruncated || !strings.Contains(mustJSON(t, d), `"stateTruncated":false`) {
		t.Fatalf("want stateTruncated false: %s", mustJSON(t, d))
	}
}
