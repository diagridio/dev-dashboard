package cmd

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
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
	baseCtx        context.Context // process-lifetime context; cancelled on shutdown so in-flight dials abort
	apps           discovery.Service
	namespace      string
	homeDir        string
	stateStorePath string
	client         *http.Client
	registry       *ConnRegistry
	pool           *connPool
	degraded       storeEntry
	// composeEnv returns the compose endpoint/mount context (nil = no compose).
	composeEnv func() discovery.ComposeEnv

	reconciling atomic.Bool // single-flight guard for background reconciles

	mu         sync.RWMutex
	fp         string
	resPaths   []string
	electedReg *storeRegistry // last election (for active() + the active flag)
	closed     bool
}

// newReconciler builds a reconciler. The registry and pool are injected (the
// pool already carries the opener used for connections). ctx is the
// process-lifetime base context: store-open contexts derive from it so that
// shutdown (Ctrl-C) aborts in-flight dials instead of blocking on them.
// composeEnv returns the compose endpoint/mount context; nil disables translation.
func newReconciler(ctx context.Context, apps discovery.Service, namespace, homeDir, stateStorePath string, client *http.Client, registry *ConnRegistry, pool *connPool, composeEnv func() discovery.ComposeEnv) *reconciler {
	if ctx == nil {
		ctx = context.Background()
	}
	return &reconciler{
		baseCtx:        ctx,
		apps:           apps,
		namespace:      namespace,
		homeDir:        homeDir,
		stateStorePath: stateStorePath,
		client:         client,
		registry:       registry,
		pool:           pool,
		composeEnv:     composeEnv,
		degraded:       buildStoreEntry(nil, namespace, client, apps),
	}
}

// translate rewrites a compose-project store's connection metadata to
// host-reachable addresses. Non-compose stores (or no compose context) pass
// through unchanged. Applied at connect/display time only — never persisted.
func (rc *reconciler) translate(c statestore.Component) statestore.Component {
	if rc.composeEnv == nil || c.Path == "" {
		return c
	}
	env := rc.composeEnv()
	projName, ok := env.ProjectForPath(c.Path)
	if !ok {
		return c
	}
	proj := env.Projects[projName]
	hosts := func(host string, port int) (string, bool) {
		hp, ok := proj.ServicePorts[host][port]
		if !ok {
			return "", false
		}
		return "localhost:" + strconv.Itoa(hp), true
	}
	paths := func(p string) (string, bool) {
		return discovery.TranslateMountPath(proj.Mounts, p)
	}
	return statestore.Translate(c, hosts, paths)
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
	resPaths, scanPaths, loaded, appPaths := derivePaths(apps, rc.homeDir, rc.stateStorePath)
	detected, err := statestore.Detect(scanPaths)
	if err != nil {
		log.Warn("state-store detection failed", "err", err)
	}
	secretStores, err := statestore.DetectSecretStores(scanPaths)
	if err != nil {
		log.Warn("secret-store detection failed", "err", err)
	}
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

	newReg := newStoreRegistry(detected, loaded, appPaths)

	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		return
	}
	rc.resPaths, rc.electedReg, rc.fp = resPaths, newReg, fp
	rc.mu.Unlock()

	// Pre-warm the elected active store through the pool. The pool retains it;
	// it is never closed when the active store later changes.
	// The open context derives from baseCtx so shutdown aborts in-flight dials.
	if active := newReg.active(); active != nil && rc.pool != nil {
		octx, cancel := context.WithTimeout(rc.baseCtx, connectTimeout)
		defer cancel()
		if _, err := rc.pool.openOrGet(octx, rc.translate(*active)); err != nil {
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

// autoDetection is a per-call memo of Detect/DetectSecretStores results over a
// set of auto-entry paths, so Stores() walks the YAML files once per call
// instead of once per auto entry. It is built, used, and discarded within a
// single call — no cross-request caching.
type autoDetection struct {
	components   []statestore.Component
	secretStores []statestore.SecretStore
}

// detectAuto runs component + secret-store detection over paths once.
func detectAuto(paths []string, log *slog.Logger) *autoDetection {
	detected, err := statestore.Detect(paths)
	if err != nil {
		log.Warn("state-store detection failed", "paths", paths, "err", err)
	}
	secretStores, err := statestore.DetectSecretStores(paths)
	if err != nil {
		log.Warn("secret-store detection failed", "paths", paths, "err", err)
	}
	return &autoDetection{components: detected, secretStores: secretStores}
}

// componentForEntry builds the statestore.Component for a registry entry.
// Manual entries use their inline metadata; auto entries are matched against
// det (a detection covering the entry's path — pass nil to detect just this
// entry's path) and 2a-resolved. A missing/unreadable YAML yields a bare
// component (connect will error).
func (rc *reconciler) componentForEntry(e ConnEntry, det *autoDetection) statestore.Component {
	if e.Source == SourceManual {
		return rc.translate(statestore.Component{Name: e.Name, Type: e.Type, Metadata: e.Metadata})
	}
	log := slog.Default().With("component", "reconciler")
	if det == nil {
		det = detectAuto([]string{e.Path}, log)
	}
	for i := range det.components {
		c := det.components[i]
		if c.Path != e.Path && !(c.Name == e.Name && underScanPath(c.Path, e.Path)) {
			continue
		}
		resolved, unresolved := statestore.ResolveSecrets(c, det.secretStores)
		if len(unresolved) > 0 {
			log.Warn("unresolved secretKeyRef metadata", "store", c.Name, "keys", unresolved)
		}
		c.Metadata = resolved
		return rc.translate(c)
	}
	// YAML missing/unreadable: return a bare component (connect will error).
	return statestore.Component{Name: e.Name, Type: e.Type, Path: e.Path}
}

// underScanPath reports whether compPath (always absolute — Detect abs-olutes
// it) was found by walking scanPath. It keeps name-fallback matches scoped to
// the entry's own path when a shared detection covers several entries' paths.
func underScanPath(compPath, scanPath string) bool {
	abs, err := filepath.Abs(scanPath)
	if err != nil {
		abs = scanPath
	}
	if compPath == scanPath || compPath == abs {
		return true
	}
	rel, err := filepath.Rel(abs, compPath)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// componentFor resolves a registry entry id to a built statestore.Component.
// auto entries are re-read from their YAML path and 2a-resolved; manual entries
// use their inline metadata. ok=false means no registry entry with that id.
func (rc *reconciler) componentFor(id string) (statestore.Component, bool) {
	if rc.registry == nil {
		return statestore.Component{}, false
	}
	for _, e := range rc.registry.List() {
		if e.ID == id {
			return rc.componentForEntry(e, nil), true
		}
	}
	return statestore.Component{}, false
}

// ptr returns a pointer to c (used to convert a value to *Component for identity).
func ptr(c statestore.Component) *statestore.Component { return &c }

// Stores satisfies server.StoreRegistry. It returns ALL registry entries (auto
// ∪ manual) with Source set and the elected active store flagged. The list
// opens NO DB connections: for each entry it builds the component (auto: read +
// resolve its YAML; manual: inline metadata) and computes the secrets-free
// ConnInfo — a file read, never a connect. A missing YAML yields an empty
// Connection (unreachable), not an error.
func (rc *reconciler) Stores() []server.StoreInfo {
	if rc.registry == nil {
		return []server.StoreInfo{}
	}
	var activeID string
	if active := rc.activeComponent(); active != nil {
		activeID = identity(ptr(rc.translate(*active)))
	}
	entries := rc.registry.List()
	// Detect all auto-entry paths in one pass and share the result across
	// entries; without this every entry re-walked its YAML path (and the old
	// componentFor(e.ID) re-scanned the whole registry per entry: O(n²)).
	var det *autoDetection
	var autoPaths []string
	seen := map[string]bool{}
	for _, e := range entries {
		if e.Source != SourceManual && !e.Dismissed && !seen[e.Path] {
			seen[e.Path] = true
			autoPaths = append(autoPaths, e.Path)
		}
	}
	if len(autoPaths) > 0 {
		det = detectAuto(autoPaths, slog.Default().With("component", "reconciler"))
	}
	out := make([]server.StoreInfo, 0, len(entries))
	for _, e := range entries {
		if e.Dismissed {
			continue
		}
		comp := rc.componentForEntry(e, det)
		out = append(out, server.StoreInfo{
			ID:         e.ID,
			Name:       e.Name,
			Type:       e.Type,
			Source:     e.Source,
			Path:       e.Path,
			Active:     identity(&comp) == activeID && activeID != "",
			Connection: statestore.ConnInfo(comp),
			UpdatedAt:  e.UpdatedAt,
		})
	}
	sortStores(out)
	return out
}

// sortStores orders panel entries: the active store first, then most recently
// added/updated, then name as a deterministic tie-break. Zero timestamps
// (entries written before updatedAt existed) sort last.
func sortStores(out []server.StoreInfo) {
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Active != out[j].Active {
			return out[i].Active
		}
		if !out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].UpdatedAt.After(out[j].UpdatedAt)
		}
		return out[i].Name < out[j].Name
	})
}

// AddStore satisfies server.StoreRegistry: adds a manual connection. The
// registry assigns its stable id from the name. A duplicate name is reported
// with a user-facing message (the API surfaces err.Error() in the 400 body).
func (rc *reconciler) AddStore(name, typ string, metadata map[string]string) error {
	if rc.registry == nil {
		return nil
	}
	err := rc.registry.Add(ConnEntry{Name: name, Type: typ, Source: SourceManual, Metadata: metadata})
	if errors.Is(err, os.ErrExist) {
		// Keep the sentinel in the chain: the API maps it to 409 via errors.Is.
		return fmt.Errorf("a connection named %q already exists: %w", name, os.ErrExist)
	}
	return err
}

// UpdateStore satisfies server.StoreRegistry: edits the manual connection with
// the given id, evicts its pooled connection (resolved before the update) so the
// next select reconnects with new metadata, and returns the recomputed id.
func (rc *reconciler) UpdateStore(id, name, typ string, metadata map[string]string) (string, error) {
	if rc.registry == nil {
		return id, nil
	}
	oldComp, hadOld := rc.componentFor(id)
	newID, err := rc.registry.Update(ConnEntry{ID: id, Name: name, Type: typ, Source: SourceManual, Metadata: metadata})
	if err != nil {
		return "", err
	}
	if hadOld && rc.pool != nil {
		rc.pool.evict(oldComp)
	}
	return newID, nil
}

// DeleteStore satisfies server.StoreRegistry: removes (manual) or tombstones
// (auto) the entry with the given id and evicts its pooled connection if open.
// The elected active store is refused with server.ErrActiveStore — running
// apps are using it — which the API maps to 409.
func (rc *reconciler) DeleteStore(id string) error {
	if rc.registry == nil {
		return nil
	}
	comp, ok := rc.componentFor(id)
	if ok {
		if active := rc.activeComponent(); active != nil && identity(&comp) == identity(ptr(rc.translate(*active))) {
			return server.ErrActiveStore
		}
	}
	if err := rc.registry.Delete(id); err != nil {
		return err
	}
	if ok && rc.pool != nil {
		rc.pool.evict(comp)
	}
	return nil
}

// ServiceFor satisfies server.WorkflowBackend. The argument is a registry entry
// id (the ?store= value), never a name.
//   - id == "" -> the elected active store, pre-warmed via the pool. If no store
//     is elected, the degraded (ErrNoStore) entry. If a store IS elected but the
//     pool cannot open it, the unreachable service (ErrStoreUnreachable).
//   - id matches a registry entry -> build its component and connect via the
//     pool; on open failure, the unreachable service.
//   - unknown id -> ok=false.
func (rc *reconciler) ServiceFor(id string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool) {
	var comp statestore.Component
	if id == "" {
		active := rc.activeComponent()
		if active == nil {
			return rc.degraded.svc, rc.degraded.rem, rc.degraded.targets, true
		}
		comp = *active
	} else {
		c, ok := rc.componentFor(id)
		if !ok {
			return nil, nil, nil, false
		}
		comp = c
	}

	// Apply compose address translation (no-op for non-compose stores) so the
	// pool key matches the pre-warmed translated entry and the dial uses the
	// host-reachable address rather than the in-container service name.
	comp = rc.translate(comp)

	// Derive from baseCtx so shutdown aborts an in-flight dial here too.
	octx, cancel := context.WithTimeout(rc.baseCtx, connectTimeout)
	defer cancel()
	e, err := rc.pool.openOrGet(octx, comp)
	if err != nil {
		// Known store, unreachable: return a service that surfaces an accurate
		// store-specific "could not connect…" error (not the no-store message),
		// reusing the degraded remover/target-resolver.
		return workflow.NewUnreachableService(comp.Name, statestore.ConnInfo(comp)),
			rc.degraded.rem, rc.degraded.targets, true
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
