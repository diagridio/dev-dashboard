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

// reconciler owns all state that used to be frozen at boot from the running-apps
// snapshot: the resource scan paths, the detected state stores, the active-store
// election, and the live workflow DB connection. It re-derives this state when
// the apps fingerprint changes, swapping the DB connection only when the elected
// active store's identity changes. All reads take the read lock and never block
// on a reconnect.
type reconciler struct {
	// immutable after construction
	apps           discovery.Service
	namespace      string
	homeDir        string
	stateStorePath string
	client         *http.Client
	open           storeOpener

	reconciling atomic.Bool // single-flight guard for background reconciles

	mu             sync.RWMutex
	fp             string
	resPaths       []string
	registry       *storeRegistry
	backend        *storeBackend
	closers        []func() error
	activeIdentity string // name|type|connInfo of the open store; "" means none
	closed         bool
}

// newReconciler builds a reconciler. open defaults to statestore.New; tests
// override it via the exported field after construction.
func newReconciler(apps discovery.Service, namespace, homeDir, stateStorePath string, client *http.Client) *reconciler {
	return &reconciler{
		apps:           apps,
		namespace:      namespace,
		homeDir:        homeDir,
		stateStorePath: stateStorePath,
		client:         client,
		open:           statestore.New,
		registry:       newStoreRegistry(nil, nil),
	}
}

// appIDs lists current app IDs; used by the workflow service for key scoping.
func (rc *reconciler) appIDs(ctx context.Context) ([]string, error) {
	apps, err := rc.apps.List(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(apps))
	for _, a := range apps {
		ids = append(ids, a.AppID)
	}
	return ids, nil
}

// identity returns a secrets-free key for connection-change detection.
func identity(c *statestore.Component) string {
	if c == nil {
		return ""
	}
	return c.Name + "|" + c.Type + "|" + statestore.ConnInfo(*c)
}

// reconcile is NOT safe for concurrent use: callers MUST ensure only one
// reconcile runs at a time (the reconcilingApps decorator's single-flight
// guard and the synchronous boot seed are the only callers).
// It re-derives state from apps and swaps it in. fp is the precomputed
// fingerprint for apps. The DB connection is reopened only when the active
// store's identity changes; if reopening fails while a working connection
// exists, the previous connection is retained (registry unchanged) and only the
// resource paths and fingerprint are refreshed.
func (rc *reconciler) reconcile(apps []discovery.Instance, fp string) {
	log := slog.Default().With("component", "reconciler")
	resPaths, scanPaths, loaded := derivePaths(apps, rc.homeDir, rc.stateStorePath)
	detected, _ := statestore.Detect(scanPaths)
	newReg := newStoreRegistry(detected, loaded)
	newID := identity(newReg.active())

	rc.mu.RLock()
	curID := rc.activeIdentity
	curHasConn := rc.backend != nil && rc.backend.activeName != ""
	rc.mu.RUnlock()

	// Active store unchanged: refresh listings only, keep the live connection.
	if newID == curID && (newReg.active() == nil || curHasConn) {
		rc.mu.Lock()
		rc.resPaths, rc.registry, rc.fp = resPaths, newReg, fp
		rc.mu.Unlock()
		return
	}

	// Active store changed: build a fresh backend (opens the new connection).
	octx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	newBackend, newClosers := newStoreBackend(octx, detected, loaded, rc.namespace, rc.client, rc.apps, rc.appIDs, rc.open)
	openFailed := newReg.active() != nil && newBackend.activeName == ""

	if openFailed && curHasConn {
		// Keep the previous working connection; only refresh resource paths + fp.
		for _, c := range newClosers {
			_ = c()
		}
		rc.mu.Lock()
		rc.resPaths, rc.fp = resPaths, fp
		rc.mu.Unlock()
		log.Warn("new active store failed to open; retaining previous connection",
			"intended", newID, "active", curID)
		return
	}

	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		for _, c := range newClosers {
			_ = c()
		}
		return
	}
	old := rc.closers
	rc.resPaths, rc.registry, rc.backend, rc.closers = resPaths, newReg, newBackend, newClosers
	rc.activeIdentity, rc.fp = newID, fp
	rc.mu.Unlock()

	for _, c := range old {
		_ = c()
	}
	log.Info("reconciled derived state", "activeStore", newID, "detected", len(detected))
}

// Stores satisfies server.StoreRegistry.
func (rc *reconciler) Stores() []server.StoreInfo {
	rc.mu.RLock()
	reg := rc.registry
	rc.mu.RUnlock()
	if reg == nil {
		return []server.StoreInfo{}
	}
	return reg.Stores()
}

// ServiceFor satisfies server.WorkflowBackend.
func (rc *reconciler) ServiceFor(name string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool) {
	rc.mu.RLock()
	b := rc.backend
	rc.mu.RUnlock()
	if b == nil {
		return nil, nil, nil, false
	}
	return b.ServiceFor(name)
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
