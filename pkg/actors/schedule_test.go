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
)

type fakeSched struct {
	runtimev1pb.UnimplementedDaprServer
	data []byte
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
			Data: &anypb.Any{Value: f.data},
		}}
	}
	return &runtimev1pb.ListActorRemindersResponse{Reminders: []*runtimev1pb.NamedActorReminder{mk("r1", "a1"), mk("r2", "a2")}}, nil
}

func (f *fakeSched) ListActorTimers(_ context.Context, req *runtimev1pb.ListActorTimersRequest) (*runtimev1pb.ListActorTimersResponse, error) {
	f.mu.Lock()
	f.timerReqs = append(f.timerReqs, req)
	f.mu.Unlock()
	return nil, f.err
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
