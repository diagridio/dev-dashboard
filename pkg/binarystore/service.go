// Package binarystore reads files from a Dapr Binary Store component through
// an app's sidecar gRPC API (GetBinaryFileAlpha1). The key goes through the
// gRPC FileName field unchanged: keys contain "/", which daprd's HTTP route
// cannot carry.
package binarystore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	runtimev1pb "github.com/dapr/dapr/pkg/proto/runtime/v1"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// MaxBytes is the largest payload Read returns (1 MiB).
const MaxBytes int64 = 1 << 20

const readTimeout = 10 * time.Second

// ConnProvider hands out gRPC connections to sidecars (workflow.SidecarPool).
type ConnProvider interface {
	Conn(addr string) (*grpc.ClientConn, error)
}

type Service struct {
	apps  discovery.Service
	conns ConnProvider
}

func New(apps discovery.Service, conns ConnProvider) *Service {
	return &Service{apps: apps, conns: conns}
}

// Read returns the bytes of file key in binary store component store, read
// via appKey's sidecar. declaredSize <= 0 means unknown.
func (s *Service) Read(ctx context.Context, appKey, store, key string, declaredSize int64) ([]byte, error) {
	if declaredSize > MaxBytes {
		return nil, &Error{Kind: KindTooLarge, Size: declaredSize, Msg: "payload too large"}
	}
	in, err := s.apps.Get(ctx, appKey)
	if err != nil {
		if errors.Is(err, discovery.ErrNotFound) {
			return nil, &Error{Kind: KindAppNotFound, Msg: "app not found"}
		}
		return nil, &Error{Kind: KindUpstream, Msg: err.Error()}
	}
	// GRPCAddr covers both host-discovered apps (127.0.0.1:<GRPCPort>) and
	// contract-declared ones (DaprGRPCAddr); "" means no known gRPC endpoint.
	addr := in.GRPCAddr()
	if !in.SidecarReachable || addr == "" {
		return nil, &Error{Kind: KindSidecarUnreachable, Msg: "sidecar unreachable"}
	}
	if !in.MetadataOK {
		return nil, &Error{Kind: KindUpstream,
			Msg: fmt.Sprintf("sidecar metadata unavailable; can't confirm %s is loaded", store)}
	}
	loaded := false
	for _, c := range in.Components {
		if c.Name == store && strings.HasPrefix(c.Type, "binarystore.") {
			loaded = true
			break
		}
	}
	if !loaded {
		return nil, &Error{Kind: KindStoreNotLoaded,
			Msg: fmt.Sprintf("binary store component '%s' is not loaded by %s", store, in.AppID)}
	}

	conn, err := s.conns.Conn(addr)
	if err != nil {
		return nil, &Error{Kind: KindSidecarUnreachable, Msg: "sidecar unreachable"}
	}

	ctx, cancel := context.WithTimeout(ctx, readTimeout)
	defer cancel()
	stream, err := runtimev1pb.NewDaprClient(conn).GetBinaryFileAlpha1(ctx, &runtimev1pb.GetBinaryFileRequestAlpha1{
		ComponentName: store,
		FileName:      key,
	})
	if err != nil {
		return nil, mapErr(err, store)
	}

	var buf []byte
	for {
		resp, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return buf, nil
		}
		if err != nil {
			return nil, mapErr(err, store)
		}
		buf = append(buf, resp.GetPayload().GetData()...)
		if int64(len(buf)) > MaxBytes {
			cancel()
			return nil, &Error{Kind: KindTooLarge, Msg: "payload too large",
				Size: max(declaredSize, int64(len(buf)))}
		}
	}
}

func timeoutErr(store string) *Error {
	return &Error{Kind: KindTimeout,
		Msg: fmt.Sprintf("sidecar didn't return the file from %s within %s", store, readTimeout)}
}

func mapErr(err error, store string) *Error {
	if errors.Is(err, context.DeadlineExceeded) {
		return timeoutErr(store)
	}
	st, _ := status.FromError(err)
	switch st.Code() {
	case codes.DeadlineExceeded:
		return timeoutErr(store)
	case codes.NotFound:
		return &Error{Kind: KindFileNotFound, Msg: "file not found in " + store}
	case codes.InvalidArgument:
		return &Error{Kind: KindInvalid, Msg: st.Message()}
	case codes.Unimplemented:
		return &Error{Kind: KindUnsupported,
			Msg: "this sidecar's Dapr version has no binary store API (requires 1.19+)"}
	case codes.Unavailable:
		return &Error{Kind: KindUpstream, Msg: st.Message(), Unavailable: true}
	default:
		return &Error{Kind: KindUpstream, Msg: st.Message()}
	}
}
