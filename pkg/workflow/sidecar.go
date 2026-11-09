package workflow

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/dapr/durabletask-go/api"
	dtwf "github.com/dapr/durabletask-go/workflow"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// ErrSidecarUnsupported marks a sidecar whose runtime predates the workflow
// management API (ListInstanceIDs/GetInstanceHistory, Dapr 1.17+).
var ErrSidecarUnsupported = errors.New("workflow inspection via the sidecar requires Dapr 1.17 or newer")

// ErrSidecarUnreachable marks a sidecar that discovery already reports as
// unreachable, or whose gRPC calls time out or fail to connect.
var ErrSidecarUnreachable = errors.New("sidecar unreachable")

// unreachableErr names the app whose sidecar cannot be reached.
func unreachableErr(appID string) error {
	return fmt.Errorf("the Dapr sidecar of app %q is unreachable: %w", appID, ErrSidecarUnreachable)
}

// SidecarEndpoint is one app's daprd gRPC endpoint.
type SidecarEndpoint struct {
	AppID string
	Addr  string // host:port, e.g. "127.0.0.1:58445"
	// Unreachable is set when discovery already knows the sidecar can't be
	// reached. All-apps reads skip it without dialing; app-scoped reads fail
	// at once with ErrSidecarUnreachable (the composite then falls back to
	// the store). The zero value means reachable.
	Unreachable bool
}

// EndpointsFunc returns the current set of sidecar-sourced apps. It is called
// per query so discovery changes (new published ports after a test rerun)
// apply immediately.
type EndpointsFunc func(ctx context.Context) []SidecarEndpoint

const (
	// metadataConcurrency caps in-flight FetchWorkflowMetadata calls per app
	// listing (the dapr CLI uses 32; local sidecars need less headroom).
	metadataConcurrency = 16
	// maxSidecarInstances bounds instances read per app per query.
	maxSidecarInstances = 1000
)

// sidecarCallTimeout bounds every per-app gRPC call sequence to the sidecar
// (instance-ID pagination + metadata fan-out in listApp, the Get call pair,
// and each AppIDs probe). A wedged or port-reused endpoint can otherwise
// hang the caller's context-less HTTP request indefinitely; because the
// budget is per app, one bad endpoint never eats into another app's time.
// A var (not a const) so tests can shrink it instead of blocking for real.
var sidecarCallTimeout = 3 * time.Second

func sidecarLogger() *slog.Logger { return slog.Default().With("component", "workflow-sidecar") }

// SidecarPool caches one gRPC client connection per endpoint address.
// grpc.NewClient is lazy, so entries are cheap; connections to ports from
// finished test runs stay idle until Close. Close on shutdown.
type SidecarPool struct {
	mu     sync.Mutex
	conns  map[string]*grpc.ClientConn
	closed bool
}

func NewSidecarPool() *SidecarPool {
	return &SidecarPool{conns: map[string]*grpc.ClientConn{}}
}

// Conn returns the cached lazy gRPC connection for addr, creating it on first
// use. Other packages (e.g. binarystore) share these connections, so the
// connection is shared: callers must not Close it (the pool owns it).
func (p *SidecarPool) Conn(addr string) (*grpc.ClientConn, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, errors.New("sidecar pool closed")
	}
	conn, ok := p.conns[addr]
	if !ok {
		c, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			return nil, err
		}
		p.conns[addr] = c
		conn = c
	}
	return conn, nil
}

func (p *SidecarPool) client(addr string) (*dtwf.Client, error) {
	conn, err := p.Conn(addr)
	if err != nil {
		return nil, err
	}
	return dtwf.NewClient(conn), nil
}

func (p *SidecarPool) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	p.closed = true
	var errs []error
	for _, c := range p.conns {
		if err := c.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	p.conns = map[string]*grpc.ClientConn{}
	return errors.Join(errs...)
}

// Service returns a workflow Service reading from the sidecars selected by eps.
func (p *SidecarPool) Service(eps EndpointsFunc) *SidecarService {
	return &SidecarService{pool: p, eps: eps}
}

// SidecarService reads workflow data live from daprd's gRPC workflow
// management API instead of the state store. It works with any backing store —
// state.in-memory included — because the sidecar itself answers.
type SidecarService struct {
	pool *SidecarPool
	eps  EndpointsFunc
}

var _ Service = (*SidecarService)(nil)

// Owns reports whether appID is served by this sidecar source.
func (s *SidecarService) Owns(ctx context.Context, appID string) bool {
	_, ok := s.endpointFor(ctx, appID)
	return ok
}

// HasEndpoints reports whether any app is currently sidecar-sourced.
func (s *SidecarService) HasEndpoints(ctx context.Context) bool {
	return len(s.eps(ctx)) > 0
}

func (s *SidecarService) endpointFor(ctx context.Context, appID string) (SidecarEndpoint, bool) {
	for _, ep := range s.eps(ctx) {
		if ep.AppID == appID {
			return ep, true
		}
	}
	return SidecarEndpoint{}, false
}

// List returns every matching instance across the sidecar-sourced apps in one
// page (NextToken is always empty: local sidecars hold bounded instance
// counts, so store-style cursor paging buys nothing here). A failing app is
// skipped and logged — one down sidecar never empties the whole page.
func (s *SidecarService) List(ctx context.Context, q ListQuery) (ListResult, error) {
	var (
		mu    sync.Mutex
		items []ExecutionSummary
	)
	s.forEachReachable(ctx, func(ep SidecarEndpoint) {
		if q.AppID != "" && ep.AppID != q.AppID {
			return
		}
		sums, err := s.listApp(ctx, ep)
		if err != nil {
			sidecarLogger().Warn("sidecar workflow list failed", "appID", ep.AppID, "addr", ep.Addr, "err", err)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		for _, sum := range sums {
			if matches(sum, q) {
				items = append(items, sum)
			}
		}
	})
	sort.SliceStable(items, func(a, b int) bool {
		return afterOrZero(items[a].CreatedAt, items[b].CreatedAt)
	})
	return ListResult{Items: items}, nil
}

// forEachReachable runs fn for every endpoint discovery reports reachable,
// concurrently (each app's calls are already bounded by sidecarCallTimeout),
// so N slow sidecars cost one timeout rather than N. Unreachable endpoints are
// skipped without dialing.
func (s *SidecarService) forEachReachable(ctx context.Context, fn func(SidecarEndpoint)) {
	var wg sync.WaitGroup
	for _, ep := range s.eps(ctx) {
		if ep.Unreachable {
			continue
		}
		wg.Add(1)
		go func(ep SidecarEndpoint) {
			defer wg.Done()
			fn(ep)
		}(ep)
	}
	wg.Wait()
}

// statsPerApp tallies the all-apps Stats query per reachable sidecar app,
// including only apps whose sidecar answered. The composite uses the key set
// to count those apps from the sidecar alone.
func (s *SidecarService) statsPerApp(ctx context.Context, q ListQuery) map[string]StatsResult {
	sq := statsQuery(q)
	var mu sync.Mutex
	out := map[string]StatsResult{}
	s.forEachReachable(ctx, func(ep SidecarEndpoint) {
		if sq.AppID != "" && ep.AppID != sq.AppID {
			return
		}
		sums, err := s.listApp(ctx, ep)
		if err != nil {
			sidecarLogger().Warn("sidecar workflow stats failed", "appID", ep.AppID, "addr", ep.Addr, "err", err)
			return
		}
		var items []ExecutionSummary
		for _, sum := range sums {
			if matches(sum, sq) {
				items = append(items, sum)
			}
		}
		mu.Lock()
		out[ep.AppID] = tally(ListResult{Items: items})
		mu.Unlock()
	})
	return out
}

// listOwned is the app-scoped List for one sidecar-owned app. Unlike List,
// which skips a failing app so one bad sidecar never errors an all-apps page,
// it surfaces the app's error so the composite can fall back to the store.
func (s *SidecarService) listOwned(ctx context.Context, q ListQuery) (ListResult, error) {
	ep, ok := s.endpointFor(ctx, q.AppID)
	if !ok {
		return ListResult{}, nil
	}
	if ep.Unreachable {
		return ListResult{}, unreachableErr(ep.AppID)
	}
	sums, err := s.listApp(ctx, ep)
	if err != nil {
		sidecarLogger().Warn("sidecar workflow list failed", "appID", ep.AppID, "addr", ep.Addr, "err", err)
		return ListResult{}, err
	}
	var items []ExecutionSummary
	for _, sum := range sums {
		if matches(sum, q) {
			items = append(items, sum)
		}
	}
	sort.SliceStable(items, func(a, b int) bool {
		return afterOrZero(items[a].CreatedAt, items[b].CreatedAt)
	})
	return ListResult{Items: items}, nil
}

// Stats tallies statuses across all matching instances (Status filter and
// paging ignored, mirroring the store-backed Stats contract).
func (s *SidecarService) Stats(ctx context.Context, q ListQuery) (StatsResult, error) {
	lr, err := s.List(ctx, statsQuery(q))
	if err != nil {
		return StatsResult{}, err
	}
	return tally(lr), nil
}

// statsQuery narrows q to the fields Stats honors (Status and paging ignored).
func statsQuery(q ListQuery) ListQuery {
	return ListQuery{AppID: q.AppID, Search: q.Search, IncludeChildren: q.IncludeChildren}
}

// tally counts a list result's instances per status.
func tally(lr ListResult) StatsResult {
	res := StatsResult{Counts: map[Status]int{}}
	for _, it := range lr.Items {
		res.Counts[it.Status]++
		res.Total++
	}
	return res
}

func (s *SidecarService) Get(ctx context.Context, appID, instanceID string) (Execution, error) {
	ep, ok := s.endpointFor(ctx, appID)
	if !ok {
		return Execution{}, ErrNotFound
	}
	if ep.Unreachable {
		return Execution{}, unreachableErr(appID)
	}
	cl, err := s.pool.client(ep.Addr)
	if err != nil {
		return Execution{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, sidecarCallTimeout)
	defer cancel()
	md, err := cl.FetchWorkflowMetadata(ctx, instanceID)
	if err != nil {
		if errors.Is(err, api.ErrInstanceNotFound) {
			return Execution{}, ErrNotFound
		}
		return Execution{}, mapSidecarErrFor(appID, err)
	}
	hist, err := cl.GetInstanceHistory(ctx, instanceID)
	if err != nil {
		return Execution{}, mapSidecarErrFor(appID, err)
	}
	events := hist.Events
	// Order like the dapr CLI: EventId when both present, else timestamp.
	sort.SliceStable(events, func(i, j int) bool {
		ei, ej := events[i], events[j]
		if ei.EventId > 0 && ej.EventId > 0 {
			return ei.EventId < ej.EventId
		}
		ti, tj := ei.GetTimestamp().AsTime(), ej.GetTimestamp().AsTime()
		if !ti.Equal(tj) {
			return ti.Before(tj)
		}
		return ei.EventId < ej.EventId
	})
	customStatus := ""
	if md.CustomStatus != nil {
		customStatus = md.CustomStatus.Value
	}
	return DecodeExecution(appID, instanceID, events, customStatus), nil
}

// AppIDs returns the sidecar-sourced apps that hold at least one instance.
func (s *SidecarService) AppIDs(ctx context.Context) ([]string, error) {
	var (
		mu  sync.Mutex
		ids []string
	)
	s.forEachReachable(ctx, func(ep SidecarEndpoint) {
		cl, err := s.pool.client(ep.Addr)
		if err != nil {
			return
		}
		probeCtx, cancel := context.WithTimeout(ctx, sidecarCallTimeout)
		resp, err := cl.ListInstanceIDs(probeCtx)
		cancel()
		if err != nil {
			sidecarLogger().Warn("sidecar workflow app probe failed", "appID", ep.AppID, "err", err)
			return
		}
		if len(resp.InstanceIds) > 0 || resp.ContinuationToken != nil {
			mu.Lock()
			ids = append(ids, ep.AppID)
			mu.Unlock()
		}
	})
	sort.Strings(ids)
	return ids, nil
}

// listApp fetches an app's instance IDs (all pages, capped) and their
// metadata with bounded concurrency.
func (s *SidecarService) listApp(ctx context.Context, ep SidecarEndpoint) ([]ExecutionSummary, error) {
	cl, err := s.pool.client(ep.Addr)
	if err != nil {
		return nil, err
	}
	// One timeout for the whole app: ID pagination plus the metadata
	// fan-out below all share this budget, so a wedged endpoint can't
	// consume more than sidecarCallTimeout regardless of instance count.
	ctx, cancel := context.WithTimeout(ctx, sidecarCallTimeout)
	defer cancel()
	resp, err := cl.ListInstanceIDs(ctx)
	if err != nil {
		return nil, mapSidecarErrFor(ep.AppID, err)
	}
	ids := append([]string{}, resp.InstanceIds...)
	for resp.ContinuationToken != nil && len(ids) < maxSidecarInstances {
		resp, err = cl.ListInstanceIDs(ctx, dtwf.WithListInstanceIDsContinuationToken(*resp.ContinuationToken))
		if err != nil {
			return nil, mapSidecarErrFor(ep.AppID, err)
		}
		ids = append(ids, resp.InstanceIds...)
	}
	if len(ids) > maxSidecarInstances {
		sidecarLogger().Warn("sidecar instance list truncated", "appID", ep.AppID, "cap", maxSidecarInstances)
		ids = ids[:maxSidecarInstances]
	}

	sums := make([]*ExecutionSummary, len(ids))
	sem := make(chan struct{}, metadataConcurrency)
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(idx int, instanceID string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			md, err := cl.FetchWorkflowMetadata(ctx, instanceID)
			if err != nil {
				sidecarLogger().Warn("sidecar workflow metadata failed", "appID", ep.AppID, "instanceID", instanceID, "err", err)
				return
			}
			sum := summaryFromMetadata(ep.AppID, instanceID, md)
			sums[idx] = &sum
		}(i, id)
	}
	wg.Wait()
	out := make([]ExecutionSummary, 0, len(sums))
	for _, s := range sums {
		if s != nil {
			out = append(out, *s)
		}
	}
	return out, nil
}

func summaryFromMetadata(appID, instanceID string, md *dtwf.WorkflowMetadata) ExecutionSummary {
	sum := ExecutionSummary{
		AppID:            appID,
		InstanceID:       instanceID,
		Name:             md.Name,
		Status:           NormalizeStatus(md.RuntimeStatus.String()),
		ParentInstanceID: md.ParentInstanceId,
	}
	if md.CreatedAt != nil {
		t := md.CreatedAt.AsTime()
		sum.CreatedAt = &t
	}
	if md.LastUpdatedAt != nil {
		t := md.LastUpdatedAt.AsTime()
		sum.LastUpdatedAt = &t
	}
	return sum
}

// mapSidecarErrFor maps a timeout or connection failure to
// ErrSidecarUnreachable naming appID, and everything else via mapSidecarErr.
func mapSidecarErrFor(appID string, err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return unreachableErr(appID)
	}
	if c, ok := status.FromError(err); ok && (c.Code() == codes.DeadlineExceeded || c.Code() == codes.Unavailable) {
		return unreachableErr(appID)
	}
	return mapSidecarErr(err)
}

// mapSidecarErr converts the pre-1.17 "not implemented" gRPC codes into
// ErrSidecarUnsupported (mirroring the dapr CLI's fallback detection).
func mapSidecarErr(err error) error {
	if c, ok := status.FromError(err); ok && (c.Code() == codes.Unimplemented || c.Code() == codes.Unknown) {
		return fmt.Errorf("%w (%v)", ErrSidecarUnsupported, err)
	}
	return err
}
