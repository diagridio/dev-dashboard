package cmd

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
)

// Compile-time interface assertions.
var _ server.StoreRegistry = (*reconciler)(nil)
var _ server.WorkflowBackend = (*reconciler)(nil)

// connectTimeout bounds a single state-store connection attempt during reconcile.
const connectTimeout = 15 * time.Second

// reconciler owns the apps-derived state: resource scan paths, the active-store
// election, the persisted connection registry, and the lazy connection pool. It
// re-derives this state when the apps fingerprint changes: auto-persisting each
// detected store to the registry and pre-warming the elected active store
// through the pool. It no longer owns a single connection or closers — the pool
// retains connections for the session.
type reconciler struct {
	// immutable after construction
	apps           discovery.Service
	namespace      string
	homeDir        string
	stateStorePath string
	client         *http.Client
	open           storeOpener
	registry       *ConnRegistry
	pool           *connPool
	degraded       storeEntry

	reconciling atomic.Bool // single-flight guard for background reconciles

	mu         sync.RWMutex
	fp         string
	resPaths   []string
	electedReg *storeRegistry // last election (for active() + the active flag)
	closed     bool
}

// newReconciler builds a reconciler. open defaults to statestore.New; tests
// override it via the exported field after construction. The registry and pool
// are injected (the pool already carries the opener used for connections).
func newReconciler(apps discovery.Service, namespace, homeDir, stateStorePath string, client *http.Client, registry *ConnRegistry, pool *connPool) *reconciler {
	return &reconciler{
		apps:           apps,
		namespace:      namespace,
		homeDir:        homeDir,
		stateStorePath: stateStorePath,
		client:         client,
		open:           statestore.New,
		registry:       registry,
		pool:           pool,
		degraded:       buildStoreEntry(nil, namespace, client, apps),
	}
}

// identity returns a secrets-free key for connection identity.
func identity(c *statestore.Component) string {
	if c == nil {
		return ""
	}
	return c.Name + "|" + c.Type + "|" + statestore.ConnInfo(*c)
}

// reconcile is NOT safe for concurrent use: callers MUST ensure only one
// reconcile runs at a time (the reconcilingApps decorator's single-flight guard
// and the synchronous boot seed are the only callers). It re-derives state from
// apps: detect + resolve stores, auto-persist them to the registry, elect the
// active store, and pre-warm it through the pool. fp is the precomputed
// fingerprint for apps.
func (rc *reconciler) reconcile(apps []discovery.Instance, fp string) {
	log := slog.Default().With("component", "reconciler")
	resPaths, scanPaths, loaded := derivePaths(apps, rc.homeDir, rc.stateStorePath)
	detected, _ := statestore.Detect(scanPaths)
	secretStores, _ := statestore.DetectSecretStores(scanPaths)
	for i := range detected {
		resolved, unresolved := statestore.ResolveSecrets(detected[i], secretStores)
		detected[i].Metadata = resolved
		if len(unresolved) > 0 {
			log.Warn("unresolved secretKeyRef metadata", "store", detected[i].Name, "keys", unresolved)
		}
		// Auto-persist every detected store as a path-ref. Persist the YAML path,
		// not the resolved metadata, so no secrets land in the registry file.
		if rc.registry != nil {
			if err := rc.registry.UpsertAuto(ConnEntry{
				Name: detected[i].Name, Type: detected[i].Type, Source: SourceAuto, Path: detected[i].Path,
			}); err != nil {
				log.Warn("auto-persist store failed", "store", detected[i].Name, "err", err)
			}
		}
	}

	newReg := newStoreRegistry(detected, loaded)

	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		return
	}
	rc.resPaths, rc.electedReg, rc.fp = resPaths, newReg, fp
	rc.mu.Unlock()

	// Pre-warm the elected active store through the pool. The pool retains it;
	// it is never closed when the active store later changes.
	if active := newReg.active(); active != nil && rc.pool != nil {
		octx, cancel := context.WithTimeout(context.Background(), connectTimeout)
		defer cancel()
		if _, err := rc.pool.openOrGet(octx, *active); err != nil {
			log.Warn("pre-warm active store failed", "store", active.Name, "err", err)
		}
	}
	log.Info("reconciled derived state", "activeStore", identity(newReg.active()), "detected", len(detected))
}

// activeComponent returns the elected active component, or nil if none.
func (rc *reconciler) activeComponent() *statestore.Component {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	if rc.electedReg == nil {
		return nil
	}
	return rc.electedReg.active()
}

// componentFor resolves a registry entry id to a built statestore.Component.
// auto entries are re-read from their YAML path and 2a-resolved; manual entries
// use their inline metadata. ok=false means no registry entry with that id.
func (rc *reconciler) componentFor(id string) (statestore.Component, bool) {
	if rc.registry == nil {
		return statestore.Component{}, false
	}
	for _, e := range rc.registry.List() {
		if e.ID != id {
			continue
		}
		switch e.Source {
		case SourceManual:
			return statestore.Component{Name: e.Name, Type: e.Type, Metadata: e.Metadata}, true
		default: // auto
			detected, _ := statestore.Detect([]string{e.Path})
			for i := range detected {
				if detected[i].Path == e.Path || detected[i].Name == e.Name {
					secretStores, _ := statestore.DetectSecretStores([]string{e.Path})
					resolved, _ := statestore.ResolveSecrets(detected[i], secretStores)
					detected[i].Metadata = resolved
					return detected[i], true
				}
			}
			// YAML missing/unreadable: return a bare component (connect will error).
			return statestore.Component{Name: e.Name, Type: e.Type, Path: e.Path}, true
		}
	}
	return statestore.Component{}, false
}

// Stores satisfies server.StoreRegistry. Reconciler-level implementation lands
// in Task 4 (all registry entries with Source + active flag). This base version
// returns the elected active store only; Task 4 replaces it.
func (rc *reconciler) Stores() []server.StoreInfo {
	active := rc.activeComponent()
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

// ServiceFor satisfies server.WorkflowBackend. The argument is a registry entry
// id (the ?store= value), never a name.
//   - id == "" -> the elected active store, pre-warmed via the pool; if no
//     store is elected, the degraded entry (ok=true).
//   - id matches a registry entry -> build its component, connect via the pool.
//   - unknown id -> ok=false.
func (rc *reconciler) ServiceFor(id string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool) {
	if id == "" {
		active := rc.activeComponent()
		if active == nil {
			return rc.degraded.svc, rc.degraded.rem, rc.degraded.targets, true
		}
		octx, cancel := context.WithTimeout(context.Background(), connectTimeout)
		defer cancel()
		e, err := rc.pool.openOrGet(octx, *active)
		if err != nil {
			return rc.degraded.svc, rc.degraded.rem, rc.degraded.targets, true
		}
		return e.svc, e.rem, e.targets, true
	}

	comp, ok := rc.componentFor(id)
	if !ok {
		return nil, nil, nil, false
	}
	octx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	e, err := rc.pool.openOrGet(octx, comp)
	if err != nil {
		// Known store, unreachable: surface a working-but-empty degraded entry so
		// the API returns a graceful error from the workflow service, not 404.
		return rc.degraded.svc, rc.degraded.rem, rc.degraded.targets, true
	}
	return e.svc, e.rem, e.targets, true
}

// Paths returns the current resource scan paths (provider for resources.New).
func (rc *reconciler) Paths() []string {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	out := make([]string, len(rc.resPaths))
	copy(out, rc.resPaths)
	return out
}

// fingerprint returns the last reconciled apps fingerprint.
func (rc *reconciler) fingerprint() string {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	return rc.fp
}

// maybeReconcile schedules a background reconcile when the apps fingerprint has
// changed and no reconcile is already in flight (single-flight). It never blocks
// the caller and never opens connections on the caller's goroutine.
func (rc *reconciler) maybeReconcile(apps []discovery.Instance) {
	fp := appsFingerprint(apps)
	if fp == rc.fingerprint() {
		return
	}
	if !rc.reconciling.CompareAndSwap(false, true) {
		return // a reconcile is already running; the next poll will catch up
	}
	go func() {
		defer rc.reconciling.Store(false)
		rc.reconcile(apps, fp)
	}()
}

// Close closes the connection pool and prevents further reconciles.
func (rc *reconciler) Close() error {
	rc.mu.Lock()
	rc.closed = true
	rc.mu.Unlock()
	if rc.pool != nil {
		return rc.pool.Close()
	}
	return nil
}

// reconcilingApps decorates a discovery.Service so every List fires a
// fingerprint-gated, single-flight reconcile. Get is a pass-through; the
// frontend polls List, which is sufficient to drive reconciliation.
type reconcilingApps struct {
	inner discovery.Service
	rc    *reconciler
}

func (d reconcilingApps) List(ctx context.Context) ([]discovery.Instance, error) {
	apps, err := d.inner.List(ctx)
	if err == nil {
		d.rc.maybeReconcile(apps)
	}
	return apps, err
}

func (d reconcilingApps) Get(ctx context.Context, appID string) (discovery.Instance, error) {
	return d.inner.Get(ctx, appID)
}
