//go:build unit

package actors

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"

	runtimev1pb "github.com/dapr/dapr/pkg/proto/runtime/v1"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type fakeSched struct {
	runtimev1pb.UnimplementedDaprServer
	data []byte
	any  *anypb.Any // overrides data when set
	err  error

	mu        sync.Mutex
	remReqs   []*runtimev1pb.ListActorRemindersRequest
	timerReqs []*runtimev1pb.ListActorTimersRequest
}

func (f *fakeSched) ListActorReminders(_ context.Context, req *runtimev1pb.ListActorRemindersRequest) (*runtimev1pb.ListActorRemindersResponse, error) {
	f.mu.Lock()
	f.remReqs = append(f.remReqs, req)
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	due, period, ttl := "1s", "5s", "1h"
	mk := func(name, id string) *runtimev1pb.NamedActorReminder {
		return &runtimev1pb.NamedActorReminder{Name: name, Reminder: &runtimev1pb.ActorReminder{
			ActorType: "Deck", ActorId: id, DueTime: &due, Period: &period, Ttl: &ttl,
			Data: f.payload(),
		}}
	}
	return &runtimev1pb.ListActorRemindersResponse{Reminders: []*runtimev1pb.NamedActorReminder{mk("r1", "a1"), mk("r2", "a2")}}, nil
}

func (f *fakeSched) ListActorTimers(_ context.Context, req *runtimev1pb.ListActorTimersRequest) (*runtimev1pb.ListActorTimersResponse, error) {
	f.mu.Lock()
	f.timerReqs = append(f.timerReqs, req)
	f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	due, period, ttl, cb := "2s", "10s", "30m", "onTick"
	return &runtimev1pb.ListActorTimersResponse{Timers: []*runtimev1pb.NamedActorTimer{{
		Name: "t1",
		Timer: &runtimev1pb.ActorTimer{
			ActorType: "Deck", ActorId: req.GetActorId(), DueTime: &due, Period: &period, Ttl: &ttl,
			Callback: &cb, Data: f.payload(),
		},
	}}}, nil
}

// payload wraps data the way daprd stores it: anypb.New(wrapperspb.Bytes(data)).
func (f *fakeSched) payload() *anypb.Any {
	if f.any != nil {
		return f.any
	}
	a, err := anypb.New(wrapperspb.Bytes(f.data))
	if err != nil {
		panic(err)
	}
	return a
}

type testConns struct {
	mu    sync.Mutex
	conns []*grpc.ClientConn
}

func (c *testConns) ConnFor(addr string, _ bool) (*grpc.ClientConn, error) {
	cc, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.conns = append(c.conns, cc)
	c.mu.Unlock()
	return cc, nil
}

func (c *testConns) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, cc := range c.conns {
		_ = cc.Close()
	}
}

func startSched(t *testing.T, srv runtimev1pb.DaprServer) (discovery.Instance, *testConns) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gs := grpc.NewServer()
	runtimev1pb.RegisterDaprServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)
	conns := &testConns{}
	t.Cleanup(conns.close)
	return discovery.Instance{
		AppID: "orders", SidecarReachable: true, RuntimeVersion: "1.19.1",
		GRPCPort: lis.Addr().(*net.TCPAddr).Port,
	}, conns
}

func TestListRemindersByType(t *testing.T) {
	f := &fakeSched{data: []byte(`{"a":1}`)}
	in, conns := startSched(t, f)

	got, err := ListReminders(context.Background(), conns, in, "Deck", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.remReqs) != 1 || f.remReqs[0].GetActorType() != "Deck" || f.remReqs[0].ActorId != nil {
		t.Fatalf("unexpected request: %+v", f.remReqs)
	}
	if len(got) != 2 {
		t.Fatalf("got %d reminders", len(got))
	}
	r := got[0]
	if r.Name != "r1" || r.ActorID != "a1" || r.DueTime != "1s" || r.Period != "5s" || r.TTL != "1h" ||
		r.Data != `{"a":1}` || r.DataEncoding != "text" || r.Callback != "" {
		t.Fatalf("unexpected reminder: %+v", r)
	}
}

func TestListRemindersBinaryData(t *testing.T) {
	f := &fakeSched{data: []byte{0xff, 0xfe, 0x00}}
	in, conns := startSched(t, f)

	got, err := ListReminders(context.Background(), conns, in, "Deck", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].DataEncoding != "base64" || got[0].Data != "//4A" {
		t.Fatalf("unexpected data: %+v", got[0])
	}
}

func TestListTimersNotOwned(t *testing.T) {
	f := &fakeSched{err: status.Error(codes.PermissionDenied, "not hosted here")}
	in, conns := startSched(t, f)

	_, err := ListTimers(context.Background(), conns, in, "Deck", "a1")
	if !errors.Is(err, ErrNotOwned) {
		t.Fatalf("got %v, want ErrNotOwned", err)
	}
}

func TestListRemindersRejectsInternal(t *testing.T) {
	f := &fakeSched{}
	in, conns := startSched(t, f)

	_, err := ListReminders(context.Background(), conns, in, "dapr.internal.default.app.workflow", nil)
	if err == nil {
		t.Fatal("want error")
	}
	if len(f.remReqs) != 0 {
		t.Fatal("RPC was made for an internal type")
	}
}

func TestListUnreachable(t *testing.T) {
	_, err := ListReminders(context.Background(), &testConns{}, discovery.Instance{RuntimeVersion: "1.19.1"}, "Deck", nil)
	if !errors.Is(err, ErrSidecarUnreachable) {
		t.Fatalf("got %v, want ErrSidecarUnreachable", err)
	}
}

func TestListRemindersUnsupportedVersion(t *testing.T) {
	_, err := ListReminders(context.Background(), &testConns{}, discovery.Instance{RuntimeVersion: "1.16.0", SidecarReachable: true}, "Deck", nil)
	if err == nil || err.Error() != "requires Dapr 1.17+" {
		t.Fatalf("got %v", err)
	}
}

func TestListTimersSuccess(t *testing.T) {
	f := &fakeSched{data: []byte(`{"n":2}`)}
	in, conns := startSched(t, f)

	got, err := ListTimers(context.Background(), conns, in, "Deck", "a1")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.timerReqs) != 1 || f.timerReqs[0].GetActorType() != "Deck" || f.timerReqs[0].GetActorId() != "a1" {
		t.Fatalf("unexpected request: %+v", f.timerReqs)
	}
	want := Scheduled{Name: "t1", ActorID: "a1", DueTime: "2s", Period: "10s", TTL: "30m",
		Callback: "onTick", Data: `{"n":2}`, DataEncoding: "text"}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestEncodeData(t *testing.T) {
	str, err := anypb.New(structpb.NewStringValue("hi"))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		in       *anypb.Any
		data     string
		encoding string
	}{
		{"nil", nil, "", "text"},
		{"bytes wrapper", mustAny(t, wrapperspb.Bytes([]byte(`{"a":1}`))), `{"a":1}`, "text"},
		{"binary bytes wrapper", mustAny(t, wrapperspb.Bytes([]byte{0xff, 0xfe})), "//4=", "base64"},
		{"other message", str, `"hi"`, "text"},
		{"unknown type falls back to raw value", &anypb.Any{TypeUrl: "type.googleapis.com/x.Unknown", Value: []byte("raw")}, "raw", "text"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d, e := encodeData(c.in)
			if d != c.data || e != c.encoding {
				t.Fatalf("got (%q, %q), want (%q, %q)", d, e, c.data, c.encoding)
			}
		})
	}
}

func mustAny(t *testing.T, m *wrapperspb.BytesValue) *anypb.Any {
	t.Helper()
	a, err := anypb.New(m)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestListUnimplementedMapsToVersionReason(t *testing.T) {
	f := &fakeSched{err: status.Error(codes.Unimplemented, "unknown method")}
	in, conns := startSched(t, f)

	_, err := ListReminders(context.Background(), conns, in, "Deck", nil)
	if !errors.Is(err, ErrUnsupportedVersion) || err.Error() != "requires Dapr 1.17+" {
		t.Fatalf("reminders: got %v", err)
	}
	_, err = ListTimers(context.Background(), conns, in, "Deck", "a1")
	if !errors.Is(err, ErrUnsupportedVersion) || err.Error() != "requires Dapr 1.19+" {
		t.Fatalf("timers: got %v", err)
	}
}

func TestListDeadlineExceededMapsToUnreachable(t *testing.T) {
	f := &fakeSched{err: status.Error(codes.DeadlineExceeded, "too slow")}
	in, conns := startSched(t, f)

	_, err := ListReminders(context.Background(), conns, in, "Deck", nil)
	if !errors.Is(err, ErrSidecarUnreachable) {
		t.Fatalf("got %v, want ErrSidecarUnreachable", err)
	}
}
