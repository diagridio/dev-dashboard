package workflow

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"

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

// SidecarEndpoint is one app's daprd gRPC endpoint.
type SidecarEndpoint struct {
	AppID string
	Addr  string // host:port, e.g. "127.0.0.1:58445"
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

func (p *SidecarPool) client(addr string) (*dtwf.Client, error) {
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
	var items []ExecutionSummary
	for _, ep := range s.eps(ctx) {
		if q.AppID != "" && ep.AppID != q.AppID {
			continue
		}
		sums, err := s.listApp(ctx, ep)
		if err != nil {
			sidecarLogger().Warn("sidecar workflow list failed", "appID", ep.AppID, "addr", ep.Addr, "err", err)
			continue
		}
		for _, sum := range sums {
			if matches(sum, q) {
				items = append(items, sum)
			}
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
	lr, err := s.List(ctx, ListQuery{AppID: q.AppID, Search: q.Search, IncludeChildren: q.IncludeChildren})
	if err != nil {
		return StatsResult{}, err
	}
	res := StatsResult{Counts: map[Status]int{}}
	for _, it := range lr.Items {
		res.Counts[it.Status]++
		res.Total++
	}
	return res, nil
}

func (s *SidecarService) Get(ctx context.Context, appID, instanceID string) (Execution, error) {
	ep, ok := s.endpointFor(ctx, appID)
	if !ok {
		return Execution{}, ErrNotFound
	}
	cl, err := s.pool.client(ep.Addr)
	if err != nil {
		return Execution{}, err
	}
	md, err := cl.FetchWorkflowMetadata(ctx, instanceID)
	if err != nil {
		if errors.Is(err, api.ErrInstanceNotFound) {
			return Execution{}, ErrNotFound
		}
		return Execution{}, mapSidecarErr(err)
	}
	hist, err := cl.GetInstanceHistory(ctx, instanceID)
	if err != nil {
		return Execution{}, mapSidecarErr(err)
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
	var ids []string
	for _, ep := range s.eps(ctx) {
		cl, err := s.pool.client(ep.Addr)
		if err != nil {
			continue
		}
		resp, err := cl.ListInstanceIDs(ctx)
		if err != nil {
			sidecarLogger().Warn("sidecar workflow app probe failed", "appID", ep.AppID, "err", err)
			continue
		}
		if len(resp.InstanceIds) > 0 || resp.ContinuationToken != nil {
			ids = append(ids, ep.AppID)
		}
	}
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
	resp, err := cl.ListInstanceIDs(ctx)
	if err != nil {
		return nil, mapSidecarErr(err)
	}
	ids := append([]string{}, resp.InstanceIds...)
	for resp.ContinuationToken != nil && len(ids) < maxSidecarInstances {
		resp, err = cl.ListInstanceIDs(ctx, dtwf.WithListInstanceIDsContinuationToken(*resp.ContinuationToken))
		if err != nil {
			return nil, mapSidecarErr(err)
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

// mapSidecarErr converts the pre-1.17 "not implemented" gRPC codes into
// ErrSidecarUnsupported (mirroring the dapr CLI's fallback detection).
func mapSidecarErr(err error) error {
	if c, ok := status.FromError(err); ok && (c.Code() == codes.Unimplemented || c.Code() == codes.Unknown) {
		return fmt.Errorf("%w (%v)", ErrSidecarUnsupported, err)
	}
	return err
}
