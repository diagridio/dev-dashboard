package actors

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	runtimev1pb "github.com/dapr/dapr/pkg/proto/runtime/v1"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// Scheduled is one actor reminder or timer. Callback is empty for reminders.
// DataEncoding is "text" (valid UTF-8) or "base64".
type Scheduled struct {
	Name         string `json:"name"`
	ActorID      string `json:"actorId"`
	DueTime      string `json:"dueTime"`
	Period       string `json:"period"`
	TTL          string `json:"ttl"`
	Callback     string `json:"callback"`
	Data         string `json:"data"`
	DataEncoding string `json:"dataEncoding"`
}

var (
	// ErrNotOwned is returned when the sidecar does not host the actor.
	ErrNotOwned = errors.New("This actor is hosted by another replica")
	// ErrSidecarUnreachable is returned when no sidecar gRPC endpoint is available.
	ErrSidecarUnreachable = errors.New("sidecar unreachable")
)

const listTimeout = 5 * time.Second

// ConnProvider hands out gRPC connections to sidecar endpoints.
type ConnProvider interface {
	ConnFor(addr string, useTLS bool) (*grpc.ClientConn, error)
}

// ListReminders lists reminders for actorType, or for one actor when actorID is set.
func ListReminders(ctx context.Context, conns ConnProvider, in discovery.Instance, actorType string, actorID *string) ([]Scheduled, error) {
	client, ctx, cancel, err := prepare(ctx, conns, in, actorType, FeatureReminderList)
	if err != nil {
		return nil, err
	}
	defer cancel()
	resp, err := client.ListActorReminders(ctx, &runtimev1pb.ListActorRemindersRequest{ActorType: actorType, ActorId: actorID})
	if err != nil {
		return nil, mapRPCError(err, FeatureReminderList)
	}
	out := make([]Scheduled, 0, len(resp.GetReminders()))
	for _, nr := range resp.GetReminders() {
		r := nr.GetReminder()
		s := Scheduled{
			Name:    nr.GetName(),
			ActorID: r.GetActorId(),
			DueTime: r.GetDueTime(),
			Period:  r.GetPeriod(),
			TTL:     r.GetTtl(),
		}
		s.Data, s.DataEncoding = encodeData(r.GetData())
		out = append(out, s)
	}
	return out, nil
}

// ListTimers lists timers for one actor. The sidecar must host that actor.
func ListTimers(ctx context.Context, conns ConnProvider, in discovery.Instance, actorType, actorID string) ([]Scheduled, error) {
	client, ctx, cancel, err := prepare(ctx, conns, in, actorType, FeatureTimerList)
	if err != nil {
		return nil, err
	}
	defer cancel()
	resp, err := client.ListActorTimers(ctx, &runtimev1pb.ListActorTimersRequest{ActorType: actorType, ActorId: actorID})
	if err != nil {
		return nil, mapRPCError(err, FeatureTimerList)
	}
	out := make([]Scheduled, 0, len(resp.GetTimers()))
	for _, nt := range resp.GetTimers() {
		t := nt.GetTimer()
		s := Scheduled{
			Name:     nt.GetName(),
			ActorID:  t.GetActorId(),
			DueTime:  t.GetDueTime(),
			Period:   t.GetPeriod(),
			TTL:      t.GetTtl(),
			Callback: t.GetCallback(),
		}
		s.Data, s.DataEncoding = encodeData(t.GetData())
		out = append(out, s)
	}
	return out, nil
}

// prepare runs the shared checks and returns a client plus a timeout context.
func prepare(ctx context.Context, conns ConnProvider, in discovery.Instance, actorType string, f Feature) (runtimev1pb.DaprClient, context.Context, context.CancelFunc, error) {
	if IsInternal(actorType) {
		return nil, nil, nil, fmt.Errorf("internal actor type %q is not supported", actorType)
	}
	if err := Supports(in.RuntimeVersion, f); err != nil {
		return nil, nil, nil, err
	}
	addr := in.GRPCAddr()
	if !in.SidecarReachable || addr == "" {
		return nil, nil, nil, ErrSidecarUnreachable
	}
	conn, err := conns.ConnFor(addr, in.DaprGRPCTLS)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: %v", ErrSidecarUnreachable, err)
	}
	ctx, cancel := context.WithTimeout(ctx, listTimeout)
	return runtimev1pb.NewDaprClient(conn), ctx, cancel, nil
}

// mapRPCError maps gRPC status codes to the package's errors. Unimplemented
// means the sidecar predates the feature, so it yields the feature's version
// reason (matching ErrUnsupportedVersion).
func mapRPCError(err error, f Feature) error {
	switch status.Code(err) {
	case codes.PermissionDenied:
		return ErrNotOwned
	case codes.Unimplemented:
		return versionError(gates[f].reason)
	case codes.DeadlineExceeded:
		return fmt.Errorf("%w: %v", ErrSidecarUnreachable, err)
	}
	return err
}

// encodeData unwraps reminder/timer data. daprd stores it as
// anypb.New(wrapperspb.Bytes(payload)), so the payload is the BytesValue's
// value; any other message is rendered as protojson; an Any that can't be
// resolved falls back to its raw value.
func encodeData(a *anypb.Any) (string, string) {
	if a == nil {
		return "", "text"
	}
	b := a.GetValue()
	if msg, err := a.UnmarshalNew(); err == nil {
		if bv, ok := msg.(*wrapperspb.BytesValue); ok {
			b = bv.GetValue()
		} else if j, err := protojson.Marshal(msg); err == nil {
			b = j
		}
	}
	if utf8.Valid(b) {
		return string(b), "text"
	}
	return base64.StdEncoding.EncodeToString(b), "base64"
}
