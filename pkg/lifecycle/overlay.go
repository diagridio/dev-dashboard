package lifecycle

import (
	"context"
	"errors"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// Overlay decorates a discovery.Service with the stopped-app registry:
// partially stopped live instances get their statuses corrected, and fully
// stopped instances (invisible to the process scan) are appended from their
// stop-time snapshots. Compose instances never hit the registry — stopped
// containers are discovered natively.
func Overlay(inner discovery.Service, reg *Registry, proc ProcController) discovery.Service {
	return &overlay{inner: inner, reg: reg, proc: proc}
}

type overlay struct {
	inner discovery.Service
	reg   *Registry
	proc  ProcController
}

func (o *overlay) List(ctx context.Context) ([]discovery.Instance, error) {
	items, err := o.inner.List(ctx)
	if err != nil {
		return nil, err
	}
	liveKeys := make(map[string]bool, len(items))
	for i := range items {
		liveKeys[items[i].InstanceKey] = true
		o.applyEntry(&items[i])
	}
	for _, e := range o.reg.List() {
		if !liveKeys[e.Instance.InstanceKey] {
			items = append(items, o.synthesize(e))
		}
	}
	sort.SliceStable(items, func(a, b int) bool {
		if items[a].AppID != items[b].AppID {
			return items[a].AppID < items[b].AppID
		}
		return items[a].InstanceKey < items[b].InstanceKey
	})
	return items, nil
}

func (o *overlay) Get(ctx context.Context, key string) (discovery.Instance, error) {
	in, err := o.inner.Get(ctx, key)
	if err == nil {
		o.applyEntry(&in)
		return in, nil
	}
	if !errors.Is(err, discovery.ErrNotFound) {
		return discovery.Instance{}, err
	}
	if e, ok := o.reg.Get(key); ok {
		return o.synthesize(e), nil
	}
	return discovery.Instance{}, err
}

// applyEntry reconciles a live instance against its registry entry. The
// scanner keys off daprd, so a live key proves daprd is back: daprd/all
// snapshots are stale. An app snapshot survives only while the app process
// has not reappeared under a new PID.
func (o *overlay) applyEntry(in *discovery.Instance) {
	e, ok := o.reg.Get(in.InstanceKey)
	if !ok || in.Source == discovery.SourceCompose {
		return
	}
	o.reg.DropTarget(in.InstanceKey, TargetDaprd)
	o.reg.DropTarget(in.InstanceKey, TargetAll)
	snap, ok := e.Procs[TargetApp]
	if !ok {
		return
	}
	if in.AppPID != 0 && in.AppPID != snap.PID {
		o.reg.DropTarget(in.InstanceKey, TargetApp) // restarted externally
		return
	}
	in.AppStatus = discovery.StatusStopped
	in.AppPID = 0
	in.AppStartedAt = ""
}

// synthesize renders a fully stopped instance from its stop-time snapshot.
func (o *overlay) synthesize(e Entry) discovery.Instance {
	in := e.Instance
	in.Health = discovery.HealthUnknown
	in.SidecarReachable = false
	in.MetadataOK = false
	in.DaprdStatus = discovery.StatusStopped
	in.DaprdPID = 0
	in.DaprdStartedAt = ""
	in.CLIPID = 0
	in.Age = ""
	in.Created = ""
	appAlive := in.AppPID != 0 && o.proc != nil && o.proc.Alive(in.AppPID)
	if _, appStopped := e.Procs[TargetApp]; appStopped || !appAlive {
		in.AppStatus = discovery.StatusStopped
		in.AppPID = 0
		in.AppStartedAt = ""
	}
	return in
}
