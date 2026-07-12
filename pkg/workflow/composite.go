package workflow

import (
	"context"
	"errors"
	"sort"
)

// composite routes workflow reads per app between the store-backed service
// and the sidecar-gRPC service:
//   - an app the sidecar source owns (testcontainers apps always; every
//     reachable app when no store is openable) is served by the sidecar;
//   - everything else is served by the store;
//   - all-apps queries merge both on the first page only (empty PageToken),
//     the sidecar winning collisions (it is live; the store copy may be a
//     stale earlier run); cursor pages (non-empty PageToken) return base
//     results alone, since the sidecar's full result set was already
//     surfaced on page one and re-merging it on every page would repeat
//     those rows.
//
// Base errors ErrNoStore/ErrStoreUnreachable are suppressed when the sidecar
// currently has endpoints — otherwise they propagate unchanged so the
// existing store banners keep firing.
type composite struct {
	base Service
	sc   *SidecarService
}

// NewComposite builds the per-app routing service. base is the store-backed
// service (possibly degraded/unreachable); sc is the sidecar source.
func NewComposite(base Service, sc *SidecarService) Service {
	return &composite{base: base, sc: sc}
}

// storeMissing reports base errors the sidecar source may stand in for.
func storeMissing(err error) bool {
	return errors.Is(err, ErrNoStore) || errors.Is(err, ErrStoreUnreachable)
}

func (c *composite) List(ctx context.Context, q ListQuery) (ListResult, error) {
	if q.AppID != "" {
		if c.sc.Owns(ctx, q.AppID) {
			return c.sc.List(ctx, q)
		}
		return c.base.List(ctx, q)
	}
	baseRes, baseErr := c.base.List(ctx, q)
	if baseErr != nil && !(storeMissing(baseErr) && c.sc.HasEndpoints(ctx)) {
		return ListResult{}, baseErr
	}
	if q.PageToken != "" {
		// Cursor page: the sidecar's full result set was already merged into
		// page one, and it has no cursor of its own to advance — re-merging
		// it here would repeat every sidecar row on every subsequent page.
		return baseRes, nil
	}
	scRes, scErr := c.sc.List(ctx, q)
	if scErr != nil {
		if baseErr != nil {
			return ListResult{}, baseErr
		}
		return baseRes, nil
	}
	if baseErr != nil {
		return scRes, nil
	}
	seen := make(map[string]struct{}, len(scRes.Items))
	items := make([]ExecutionSummary, 0, len(scRes.Items)+len(baseRes.Items))
	for _, it := range scRes.Items {
		seen[it.AppID+"/"+it.InstanceID] = struct{}{}
		items = append(items, it)
	}
	for _, it := range baseRes.Items {
		if _, dup := seen[it.AppID+"/"+it.InstanceID]; dup {
			continue
		}
		items = append(items, it)
	}
	sort.SliceStable(items, func(a, b int) bool {
		return afterOrZero(items[a].CreatedAt, items[b].CreatedAt)
	})
	return ListResult{Items: items, NextToken: baseRes.NextToken}, nil
}

func (c *composite) Stats(ctx context.Context, q ListQuery) (StatsResult, error) {
	if q.AppID != "" {
		if c.sc.Owns(ctx, q.AppID) {
			return c.sc.Stats(ctx, q)
		}
		return c.base.Stats(ctx, q)
	}
	baseRes, baseErr := c.base.Stats(ctx, q)
	if baseErr != nil && !(storeMissing(baseErr) && c.sc.HasEndpoints(ctx)) {
		return StatsResult{}, baseErr
	}
	scRes, scErr := c.sc.Stats(ctx, q)
	if scErr != nil {
		if baseErr != nil {
			return StatsResult{}, baseErr
		}
		return baseRes, nil
	}
	if baseErr != nil {
		return scRes, nil
	}
	// Counts are summed; an app-id present in both sources (a testcontainers
	// app whose id also has stale store data) can double-count — instance
	// identity is not available at stats granularity. Rare and benign locally.
	out := StatsResult{Counts: map[Status]int{}}
	for k, v := range baseRes.Counts {
		out.Counts[k] += v
	}
	for k, v := range scRes.Counts {
		out.Counts[k] += v
	}
	out.Total = baseRes.Total + scRes.Total
	return out, nil
}

func (c *composite) Get(ctx context.Context, appID, instanceID string) (Execution, error) {
	if c.sc.Owns(ctx, appID) {
		return c.sc.Get(ctx, appID, instanceID)
	}
	return c.base.Get(ctx, appID, instanceID)
}

func (c *composite) AppIDs(ctx context.Context) ([]string, error) {
	baseIDs, baseErr := c.base.AppIDs(ctx)
	if baseErr != nil && !(storeMissing(baseErr) && c.sc.HasEndpoints(ctx)) {
		return nil, baseErr
	}
	scIDs, scErr := c.sc.AppIDs(ctx)
	if scErr != nil && baseErr != nil {
		return nil, baseErr
	}
	seen := map[string]struct{}{}
	var ids []string
	for _, id := range append(baseIDs, scIDs...) {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}
