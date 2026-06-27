package cmd

import (
	"context"
	"fmt"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
)

// Compile-time interface assertions.
var _ server.StoreRegistry = (*storeRegistry)(nil)
var _ server.TargetResolver = (*targetResolver)(nil)
var _ server.WorkflowBackend = (*storeBackend)(nil)

// storeRegistry wraps a slice of detected state-store components and exposes the
// server.StoreRegistry interface. The active component is computed once at
// construction time.
type storeRegistry struct {
	comps       []statestore.Component
	activeIndex int // -1 means no active component
}

// newStoreRegistry builds a storeRegistry from a slice of detected components.
// The active component is the one with actorStateStore=="true" in its Metadata,
// or the first component if none has that flag, or none if the slice is empty.
func newStoreRegistry(comps []statestore.Component) *storeRegistry {
	r := &storeRegistry{comps: comps, activeIndex: -1}
	for i, c := range comps {
		if c.Metadata["actorStateStore"] == "true" {
			r.activeIndex = i
			return r
		}
	}
	if len(comps) > 0 {
		r.activeIndex = 0
	}
	return r
}

// active returns a pointer to the active component, or nil if none.
func (r *storeRegistry) active() *statestore.Component {
	if r.activeIndex < 0 {
		return nil
	}
	return &r.comps[r.activeIndex]
}

// Stores satisfies server.StoreRegistry and maps each component to a StoreInfo.
func (r *storeRegistry) Stores() []server.StoreInfo {
	out := make([]server.StoreInfo, len(r.comps))
	for i, c := range r.comps {
		out[i] = server.StoreInfo{
			Name:   c.Name,
			Type:   c.Type,
			Path:   c.Path,
			Active: i == r.activeIndex,
		}
	}
	return out
}

// targetResolver resolves an (appID, instanceID) pair into a workflow.RemoveTarget
// by combining information from the discovery service and the workflow service.
type targetResolver struct {
	apps discovery.Service
	wf   workflow.Service
}

// newTargetResolver builds a targetResolver.
func newTargetResolver(apps discovery.Service, wf workflow.Service) *targetResolver {
	return &targetResolver{apps: apps, wf: wf}
}

// Resolve satisfies server.TargetResolver. It fetches the instance's HTTP port
// and health from discovery, and its current status from the workflow service.
// If discovery fails, the target is returned with HTTPPort=0 and Healthy=false
// (allowing force-delete). If the workflow lookup fails, the error is returned.
func (r *targetResolver) Resolve(ctx context.Context, appID, instanceID string) (workflow.RemoveTarget, error) {
	var httpPort int
	var healthy bool

	inst, err := r.apps.Get(ctx, appID)
	if err == nil {
		httpPort = inst.HTTPPort
		healthy = inst.Health == discovery.HealthHealthy
	}
	// If apps.Get failed, continue with httpPort=0, healthy=false (force path only).

	ex, err := r.wf.Get(ctx, appID, instanceID)
	if err != nil {
		return workflow.RemoveTarget{}, fmt.Errorf("resolve workflow %s/%s: %w", appID, instanceID, err)
	}

	return workflow.RemoveTarget{
		AppID:      appID,
		InstanceID: instanceID,
		Status:     ex.Status,
		HTTPPort:   httpPort,
		Healthy:    healthy,
	}, nil
}

// storeEntry holds the per-store workflow service, remover, and target resolver.
type storeEntry struct {
	svc     workflow.Service
	rem     server.WorkflowRemover
	targets server.TargetResolver
}

// storeBackend implements server.WorkflowBackend. It holds one storeEntry per
// detected state-store component (keyed by component Name), plus a degraded
// entry used when no stores are configured at all.
type storeBackend struct {
	services   map[string]storeEntry
	activeName string
	degraded   storeEntry
}

// ServiceFor satisfies server.WorkflowBackend. An empty name selects the active
// store (or degraded if no stores). An unknown explicit name returns ok=false.
func (b *storeBackend) ServiceFor(name string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool) {
	if name == "" {
		name = b.activeName
	}
	if name == "" {
		// No stores configured: return the degraded entry.
		return b.degraded.svc, b.degraded.rem, b.degraded.targets, true
	}
	e, ok := b.services[name]
	if !ok {
		return nil, nil, nil, false
	}
	return e.svc, e.rem, e.targets, true
}

// newStoreBackend constructs a storeBackend from detected state-store components.
// For each component, it initialises a statestore.Store, a workflow.Service,
// a workflow.Remover, and a targetResolver. Components that fail initialisation
// are skipped with a warning.
//
// It returns the backend and a slice of close funcs (one per successfully opened
// store) that should be deferred by the caller.
func newStoreBackend(
	ctx context.Context,
	comps []statestore.Component,
	namespace string,
	client *http.Client,
	apps discovery.Service,
	appIDs func(context.Context) ([]string, error),
) (*storeBackend, []func() error) {
	b := &storeBackend{
		services: make(map[string]storeEntry),
	}
	var closers []func() error

	registry := newStoreRegistry(comps)

	for _, comp := range comps {
		st, err := statestore.New(ctx, comp)
		if err != nil {
			fmt.Printf("warning: state store %q init failed: %v (skipping)\n", comp.Name, err)
			continue
		}
		closers = append(closers, st.Close)

		svc := workflow.New(st, namespace, appIDs)
		rem := workflow.NewRemover(client, st, namespace)
		res := newTargetResolver(apps, svc)
		b.services[comp.Name] = storeEntry{svc: svc, rem: rem, targets: res}
	}

	// Set activeName from the registry (actorStateStore wins, else first).
	if active := registry.active(); active != nil {
		if _, ok := b.services[active.Name]; ok {
			b.activeName = active.Name
		}
	}

	// Build the degraded entry (nil store) used when no stores are configured.
	// This is the no-store safety net: ServiceFor("") returns it so callers get
	// a working (but limited) service even when no state stores are detected.
	degradedSvc := workflow.New(nil, namespace, appIDs)
	degradedRem := workflow.NewRemover(client, nil, namespace)
	degradedRes := newTargetResolver(apps, degradedSvc)
	b.degraded = storeEntry{svc: degradedSvc, rem: degradedRem, targets: degradedRes}

	return b, closers
}
