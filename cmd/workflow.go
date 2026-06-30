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

// storeOpener opens a state store from a component spec. Production uses
// statestore.New; tests inject a fake to assert connection lifecycle.
type storeOpener func(context.Context, statestore.Component) (statestore.Store, error)

// storeRegistry wraps a slice of detected state-store components and exposes the
// server.StoreRegistry interface. The active component is computed once at
// construction time.
type storeRegistry struct {
	comps       []statestore.Component
	activeIndex int // -1 means no active component
}

// newStoreRegistry builds a storeRegistry from detected components and the set of
// state-store component names that running apps have actually loaded.
//
// Active-store election precedence:
//  1. app-loaded AND actorStateStore=="true"
//  2. app-loaded (any)
//  3. actorStateStore=="true"
//  4. first component
//  5. none (empty slice)
//
// Preferring app-loaded stores stops the global ~/.dapr default (also flagged
// actorStateStore) from shadowing the store an externally-launched app (e.g. one
// started by .NET Aspire) actually loaded.
func newStoreRegistry(comps []statestore.Component, loaded map[string]bool) *storeRegistry {
	r := &storeRegistry{comps: comps, activeIndex: -1}
	if len(comps) == 0 {
		return r
	}

	isLoaded := func(c statestore.Component) bool { return loaded != nil && loaded[c.Name] }
	isActor := func(c statestore.Component) bool { return c.Metadata["actorStateStore"] == "true" }

	// 1. app-loaded AND actorStateStore.
	for i, c := range comps {
		if isLoaded(c) && isActor(c) {
			r.activeIndex = i
			return r
		}
	}
	// 2. app-loaded (any).
	for i, c := range comps {
		if isLoaded(c) {
			r.activeIndex = i
			return r
		}
	}
	// 3. actorStateStore.
	for i, c := range comps {
		if isActor(c) {
			r.activeIndex = i
			return r
		}
	}
	// 4. first component.
	r.activeIndex = 0
	return r
}

// active returns a pointer to the active component, or nil if none.
func (r *storeRegistry) active() *statestore.Component {
	if r.activeIndex < 0 {
		return nil
	}
	return &r.comps[r.activeIndex]
}

// Stores satisfies server.StoreRegistry. It returns ONLY the active state store
// (the one used by Dapr Workflow), or an empty slice when no store is detected.
// The connection summary is secrets-free (see statestore.ConnInfo).
func (r *storeRegistry) Stores() []server.StoreInfo {
	active := r.active()
	if active == nil {
		return []server.StoreInfo{}
	}
	return []server.StoreInfo{{
		Name:       active.Name,
		Type:       active.Type,
		Path:       active.Path,
		Active:     true,
		Connection: statestore.ConnInfo(*active),
	}}
}

// AddStore is a no-op on the internal storeRegistry (read-only from detected components).
func (r *storeRegistry) AddStore(string, string, map[string]string) error { return nil }

// UpdateStore is a no-op on the internal storeRegistry (read-only from detected components).
func (r *storeRegistry) UpdateStore(string, string, string, map[string]string) error { return nil }

// DeleteStore is a no-op on the internal storeRegistry (read-only from detected components).
func (r *storeRegistry) DeleteStore(string) error { return nil }

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

// buildStoreEntry assembles the per-store workflow service, remover, and target
// resolver for an already-opened state store. It is the construction the old
// newStoreBackend did inline; the connpool reuses it for each opened identity.
func buildStoreEntry(st statestore.Store, namespace string, client *http.Client, apps discovery.Service) storeEntry {
	svc := workflow.New(st, namespace)
	rem := workflow.NewRemover(client, st, namespace)
	res := newTargetResolver(apps, svc)
	return storeEntry{svc: svc, rem: rem, targets: res}
}
