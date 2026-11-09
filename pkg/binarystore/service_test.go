//go:build unit

package binarystore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	commonv1pb "github.com/dapr/dapr/pkg/proto/common/v1"
	runtimev1pb "github.com/dapr/dapr/pkg/proto/runtime/v1"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// fakeDaprFull overrides GetBinaryFileAlpha1 with a scripted response.
type fakeDaprFull struct {
	runtimev1pb.UnimplementedDaprServer
	chunks [][]byte
	err    error

	mu    sync.Mutex
	calls []*runtimev1pb.GetBinaryFileRequestAlpha1
}

func (f *fakeDaprFull) GetBinaryFileAlpha1(req *runtimev1pb.GetBinaryFileRequestAlpha1, stream runtimev1pb.Dapr_GetBinaryFileAlpha1Server) error {
	f.mu.Lock()
	f.calls = append(f.calls, req)
	f.mu.Unlock()
	for i, c := range f.chunks {
		if err := stream.Send(&runtimev1pb.GetBinaryFileResponseAlpha1{
			Payload: &commonv1pb.StreamPayload{Data: c, Seq: uint64(i)},
		}); err != nil {
			return err
		}
	}
	return f.err
}

func (f *fakeDaprFull) recorded() []*runtimev1pb.GetBinaryFileRequestAlpha1 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*runtimev1pb.GetBinaryFileRequestAlpha1(nil), f.calls...)
}

// fakeDaprNoImpl does not override the method (Unimplemented).
type fakeDaprNoImpl struct {
	runtimev1pb.UnimplementedDaprServer
}

type fakeApps struct{ instances []discovery.Instance }

func (f *fakeApps) List(context.Context) ([]discovery.Instance, error) { return f.instances, nil }
func (f *fakeApps) Get(_ context.Context, key string) (discovery.Instance, error) {
	for _, i := range f.instances {
		if i.AppID == key {
			return i, nil
		}
	}
	return discovery.Instance{}, fmt.Errorf("%w: %s", discovery.ErrNotFound, key)
}

type testConns struct {
	mu    sync.Mutex
	conns []*grpc.ClientConn
}

func (c *testConns) Conn(addr string) (*grpc.ClientConn, error) {
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

// startServer starts srv on 127.0.0.1:0 and returns the port and a stop func.
func startServer(t *testing.T, srv runtimev1pb.DaprServer) (int, func()) {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gs := grpc.NewServer()
	runtimev1pb.RegisterDaprServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	var once sync.Once
	stop := func() { once.Do(gs.Stop) }
	t.Cleanup(stop)
	return lis.Addr().(*net.TCPAddr).Port, stop
}

func newSvc(t *testing.T, inst discovery.Instance) *Service {
	t.Helper()
	conns := &testConns{}
	t.Cleanup(conns.close)
	return New(&fakeApps{instances: []discovery.Instance{inst}}, conns)
}

func inst(port int) discovery.Instance {
	return discovery.Instance{
		AppID: "orders", SidecarReachable: true, MetadataOK: true, GRPCPort: port,
		Components: []discovery.Component{{Name: "payloads", Type: "binarystore.in-memory"}},
	}
}

func wantKind(t *testing.T, err error, k Kind) *Error {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("want *Error, got %v", err)
	}
	if e.Kind != k {
		t.Fatalf("kind = %v (%s), want %v", e.Kind, e.Msg, k)
	}
	return e
}

func TestRead_ConcatenatesChunks(t *testing.T) {
	f := &fakeDaprFull{chunks: [][]byte{[]byte("ab"), []byte("cd")}}
	port, _ := startServer(t, f)
	got, err := newSvc(t, inst(port)).Read(context.Background(), "orders", "payloads", "k", 0)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "abcd" {
		t.Fatalf("got %q", got)
	}
	calls := f.recorded()
	if len(calls) != 1 || calls[0].ComponentName != "payloads" {
		t.Fatalf("calls = %v", calls)
	}
}

// Contract-declared apps (compose/aspire container posture) carry no
// GRPCPort; their sidecar is addressed by DaprGRPCAddr instead.
func TestRead_UsesContractGRPCAddr(t *testing.T) {
	f := &fakeDaprFull{chunks: [][]byte{[]byte("ok")}}
	port, _ := startServer(t, f)
	i := inst(0)
	i.DaprGRPCAddr = "127.0.0.1:" + strconv.Itoa(port)
	got, err := newSvc(t, i).Read(context.Background(), "orders", "payloads", "k", 0)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ok" {
		t.Fatalf("got %q", got)
	}
}

func TestRead_KeyPassesThroughUnchanged(t *testing.T) {
	f := &fakeDaprFull{chunks: [][]byte{[]byte("x")}}
	port, _ := startServer(t, f)
	key := "workflow-payloads/order 42/é9f86"
	if _, err := newSvc(t, inst(port)).Read(context.Background(), "orders", "payloads", key, 0); err != nil {
		t.Fatal(err)
	}
	calls := f.recorded()
	if len(calls) != 1 || calls[0].FileName != key {
		t.Fatalf("calls = %v", calls)
	}
}

func TestRead_AppNotFound(t *testing.T) {
	s := New(&fakeApps{}, &testConns{})
	_, err := s.Read(context.Background(), "nope", "payloads", "k", 0)
	wantKind(t, err, KindAppNotFound)
}

func TestRead_SidecarUnreachable(t *testing.T) {
	i := inst(1234)
	i.SidecarReachable = false
	_, err := newSvc(t, i).Read(context.Background(), "orders", "payloads", "k", 0)
	wantKind(t, err, KindSidecarUnreachable)
}

func TestRead_NoGRPCPort(t *testing.T) {
	_, err := newSvc(t, inst(0)).Read(context.Background(), "orders", "payloads", "k", 0)
	wantKind(t, err, KindSidecarUnreachable)
}

func TestRead_StoreNotLoaded(t *testing.T) {
	f := &fakeDaprFull{}
	port, _ := startServer(t, f)
	i := inst(port)
	i.Components = append(i.Components, discovery.Component{Name: "cache", Type: "state.redis"})
	svc := newSvc(t, i)

	e := wantKind(t, readErr(svc, "other"), KindStoreNotLoaded)
	if e.Msg != "binary store component 'other' is not loaded by orders" {
		t.Fatalf("msg = %q", e.Msg)
	}
	// Same name but wrong component type.
	wantKind(t, readErr(svc, "cache"), KindStoreNotLoaded)
	if n := len(f.recorded()); n != 0 {
		t.Fatalf("sidecar called %d times", n)
	}
}

func TestRead_MetadataUnavailable(t *testing.T) {
	f := &fakeDaprFull{}
	port, _ := startServer(t, f)
	i := inst(port)
	i.Components = nil
	i.MetadataOK = false
	e := wantKind(t, readErr(newSvc(t, i), "payloads"), KindUpstream)
	if e.Msg != "sidecar metadata unavailable; can't confirm payloads is loaded" {
		t.Fatalf("msg = %q", e.Msg)
	}
	if n := len(f.recorded()); n != 0 {
		t.Fatalf("sidecar called %d times", n)
	}
}

func readErr(s *Service, store string) error {
	_, err := s.Read(context.Background(), "orders", store, "k", 0)
	return err
}

func TestRead_NotFound(t *testing.T) {
	port, _ := startServer(t, &fakeDaprFull{err: status.Error(codes.NotFound, "nope")})
	e := wantKind(t, readErr(newSvc(t, inst(port)), "payloads"), KindFileNotFound)
	if e.Msg != "file not found in payloads" {
		t.Fatalf("msg = %q", e.Msg)
	}
}

func TestRead_Unimplemented(t *testing.T) {
	port, _ := startServer(t, &fakeDaprNoImpl{})
	e := wantKind(t, readErr(newSvc(t, inst(port)), "payloads"), KindUnsupported)
	if !strings.Contains(e.Msg, "requires 1.19+") {
		t.Fatalf("msg = %q", e.Msg)
	}
}

func TestRead_Invalid(t *testing.T) {
	port, _ := startServer(t, &fakeDaprFull{err: status.Error(codes.InvalidArgument, "bad name")})
	e := wantKind(t, readErr(newSvc(t, inst(port)), "payloads"), KindInvalid)
	if e.Msg != "bad name" {
		t.Fatalf("msg = %q", e.Msg)
	}
}

func TestRead_DeclaredSizeTooLarge(t *testing.T) {
	f := &fakeDaprFull{chunks: [][]byte{[]byte("x")}}
	port, _ := startServer(t, f)
	_, err := newSvc(t, inst(port)).Read(context.Background(), "orders", "payloads", "k", 1048577)
	e := wantKind(t, err, KindTooLarge)
	if e.Size != 1048577 {
		t.Fatalf("size = %d", e.Size)
	}
	if n := len(f.recorded()); n != 0 {
		t.Fatalf("sidecar called %d times", n)
	}
}

func chunked(total, chunk int) [][]byte {
	var out [][]byte
	for total > 0 {
		n := min(chunk, total)
		out = append(out, bytes.Repeat([]byte("a"), n))
		total -= n
	}
	return out
}

func TestRead_ExactlyMaxBytesAllowed(t *testing.T) {
	port, _ := startServer(t, &fakeDaprFull{chunks: chunked(1048576, 64*1024)})
	got, err := newSvc(t, inst(port)).Read(context.Background(), "orders", "payloads", "k", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1048576 {
		t.Fatalf("len = %d", len(got))
	}
}

func TestRead_StreamExceedsMax(t *testing.T) {
	port, _ := startServer(t, &fakeDaprFull{chunks: chunked(1048577, 64*1024)})
	got, err := newSvc(t, inst(port)).Read(context.Background(), "orders", "payloads", "k", 10)
	e := wantKind(t, err, KindTooLarge)
	if got != nil {
		t.Fatalf("got %d bytes", len(got))
	}
	if e.Size < 1048577 {
		t.Fatalf("size = %d", e.Size)
	}
}

func TestRead_MidStreamErrorIsNotSuccess(t *testing.T) {
	port, _ := startServer(t, &fakeDaprFull{chunks: [][]byte{[]byte("ab")}, err: status.Error(codes.Internal, "boom")})
	got, err := newSvc(t, inst(port)).Read(context.Background(), "orders", "payloads", "k", 0)
	e := wantKind(t, err, KindUpstream)
	if got != nil {
		t.Fatalf("got %q", got)
	}
	if e.Unavailable {
		t.Fatal("Internal must not be Unavailable")
	}
}

// fakeDaprSlow blocks until the client gives up.
type fakeDaprSlow struct {
	runtimev1pb.UnimplementedDaprServer
}

func (fakeDaprSlow) GetBinaryFileAlpha1(_ *runtimev1pb.GetBinaryFileRequestAlpha1, stream runtimev1pb.Dapr_GetBinaryFileAlpha1Server) error {
	<-stream.Context().Done()
	return stream.Context().Err()
}

func TestRead_DeadlineExceeded(t *testing.T) {
	port, _ := startServer(t, fakeDaprSlow{})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := newSvc(t, inst(port)).Read(ctx, "orders", "payloads", "k", 0)
	e := wantKind(t, err, KindTimeout)
	if !strings.Contains(e.Msg, "payloads") {
		t.Fatalf("msg %q should name the store", e.Msg)
	}
}

func TestRead_Unavailable(t *testing.T) {
	port, stop := startServer(t, &fakeDaprFull{})
	stop()
	_, err := newSvc(t, inst(port)).Read(context.Background(), "orders", "payloads", "k", 0)
	e := wantKind(t, err, KindUpstream)
	if !e.Unavailable {
		t.Fatal("want Unavailable")
	}
}
