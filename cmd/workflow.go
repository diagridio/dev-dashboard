package cmd

import (
	"context"
	"fmt"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
)

// Compile-time interface assertions.
var _ server.StoreRegistry = (*storeRegistry)(nil)
var _ server.TargetResolver = (*targetResolver)(nil)

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
