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
// An app-scoped read of a sidecar-owned app that the sidecar cannot answer
// (unreachable, or a pre-1.17 daprd without the workflow management API)
// falls back to the store; if the store fails too, the sidecar outcome stands.
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
			return c.ownedList(ctx, q)
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
			return c.ownedStats(ctx, q)
		}
		return c.base.Stats(ctx, q)
	}
	baseRes, baseErr := c.base.Stats(ctx, q)
	if baseErr != nil && !(storeMissing(baseErr) && c.sc.HasEndpoints(ctx)) {
		return StatsResult{}, baseErr
	}
	perApp := c.sc.statsPerApp(ctx, q)
	out := StatsResult{Counts: map[Status]int{}}
	for _, r := range perApp {
		addStats(&out, r, 1)
	}
	if baseErr != nil {
		return out, nil
	}
	addStats(&out, baseRes, 1)
	// An app the sidecar answered for is counted from the sidecar alone: the
	// store usually is that sidecar's actor store, so its workflows would
	// otherwise count twice (the merged list shows them once). Apps whose
	// sidecar failed keep their store counts, matching the store fallback.
	for appID := range perApp {
		aq := statsQuery(q)
		aq.AppID = appID
		if b, err := c.base.Stats(ctx, aq); err == nil {
			addStats(&out, b, -1)
		}
	}
	return out, nil
}

// addStats adds sign*r into out, never letting a count drop below zero.
func addStats(out *StatsResult, r StatsResult, sign int) {
	for k, v := range r.Counts {
		n := out.Counts[k] + sign*v
		if n <= 0 {
			delete(out.Counts, k)
			continue
		}
		out.Counts[k] = n
	}
	total := 0
	for _, v := range out.Counts {
		total += v
	}
	out.Total = total
}

func (c *composite) Get(ctx context.Context, appID, instanceID string) (Execution, error) {
	if c.sc.Owns(ctx, appID) {
		ex, err := c.sc.Get(ctx, appID, instanceID)
		if err == nil {
			return ex, nil
		}
		if fb, fbErr := c.base.Get(ctx, appID, instanceID); fbErr == nil {
			return fb, nil
		}
		return Execution{}, err
	}
	return c.base.Get(ctx, appID, instanceID)
}

// ownedList serves an app-scoped list for a sidecar-owned app, falling back
// to the store when the sidecar fails. With no usable store the failing app
// yields an empty list, matching the all-apps rule that one bad sidecar never
// errors the page.
func (c *composite) ownedList(ctx context.Context, q ListQuery) (ListResult, error) {
	res, err := c.sc.listOwned(ctx, q)
	if err == nil {
		return res, nil
	}
	if fb, fbErr := c.base.List(ctx, q); fbErr == nil {
		return fb, nil
	}
	return ListResult{}, nil
}

// ownedStats is the Stats counterpart of ownedList.
func (c *composite) ownedStats(ctx context.Context, q ListQuery) (StatsResult, error) {
	lr, err := c.sc.listOwned(ctx, statsQuery(q))
	if err != nil {
		if fb, fbErr := c.base.Stats(ctx, q); fbErr == nil {
			return fb, nil
		}
		return StatsResult{Counts: map[Status]int{}}, nil
	}
	return tally(lr), nil
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
