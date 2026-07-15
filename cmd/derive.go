package cmd

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"sort"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// derivePaths computes, from the current running apps, the inputs that were
// previously frozen at boot:
//   - resPaths:  directories the resources loader scans
//   - scanPaths: paths statestore.Detect walks for state-store components
//   - loaded:    set of state-store component names at least one app loaded
//
// stateStorePath, when non-empty, is an explicit component YAML that overrides
// state-store auto-detection (scanPaths becomes exactly that path).
// extraResPaths are appended to resPaths only (scanPaths untouched) — the
// aspire-mode resources path(s) live alongside apps' own resource paths but
// must not participate in state-store auto-detection, which the explicit
// statestore path owns.
func derivePaths(apps []discovery.Instance, homeDir, stateStorePath string, extraResPaths []string) (resPaths, scanPaths []string, loaded map[string]bool, appPaths []string) {
	loaded = make(map[string]bool)
	for _, a := range apps {
		// Election inputs (loaded, appPaths) count only running apps: a stopped
		// app's daprd no longer serves its store, so it must not provide the
		// active store (a stopped compose project would otherwise win election
		// over a running app's own store). The store still stays detectable and
		// listable via scanPaths/resPaths below, which include every app.
		if !appRunning(a) {
			continue
		}
		for _, c := range a.Components {
			if strings.HasPrefix(c.Type, "state.") {
				loaded[c.Name] = true
			}
		}
		// Testcontainers apps' ResourcePaths are virtual (e.g.
		// "crazy_lamport:/dapr-resources", a container name + in-container
		// path, not a host path). They intentionally flow through here
		// unchanged: every walker below (state-store detection, resource
		// loading) treats a nonexistent host path as a no-op, so mixing
		// virtual and real paths is harmless. See
		// TestVirtualPathsDoNotFeedStoreDetection in cmd/serve_test.go, which
		// pins that a virtual path yields zero detected components.
		appPaths = append(appPaths, a.ResourcePaths...)
	}

	if stateStorePath != "" {
		scanPaths = []string{stateStorePath}
	} else {
		if homeDir != "" {
			scanPaths = append(scanPaths, filepath.Join(homeDir, ".dapr", "components"))
		}
		for _, a := range apps {
			scanPaths = append(scanPaths, a.ResourcePaths...)
		}
	}

	if homeDir != "" {
		resPaths = append(resPaths, filepath.Join(homeDir, ".dapr", "components"), filepath.Join(homeDir, ".dapr"))
	}
	for _, a := range apps {
		resPaths = append(resPaths, a.ResourcePaths...)
		if a.ConfigPath != "" {
			resPaths = append(resPaths, filepath.Dir(a.ConfigPath))
		}
	}
	resPaths = append(resPaths, extraResPaths...)
	return resPaths, scanPaths, loaded, appPaths
}

// appRunning reports whether an app's daprd sidecar is live enough for its
// state store to count toward active-store election. A daprd reported
// "stopped" is excluded; an unknown ("") status counts as running, preserving
// behavior for discovery sources that don't report daprd status.
func appRunning(a discovery.Instance) bool {
	return a.DaprdStatus != "stopped"
}

// appsFingerprint hashes the apps-derived inputs that the reconciler depends on:
// the set of app IDs, the list (multiset, no dedup) of resource paths +
// config-file dirs, the set of loaded state-store component names, and the set
// of currently-running app IDs. The running set is included so a running->
// stopped flip re-triggers reconcile (and thus re-election), even when ids,
// paths, and stores are otherwise unchanged.
// Deduplication of paths happens downstream in statestore.Detect.
// Order-independent: same content yields the same fingerprint regardless of
// app ordering.
func appsFingerprint(apps []discovery.Instance) string {
	var ids, paths, stores, running []string
	for _, a := range apps {
		ids = append(ids, a.AppID)
		paths = append(paths, a.ResourcePaths...)
		if a.ConfigPath != "" {
			paths = append(paths, filepath.Dir(a.ConfigPath))
		}
		for _, c := range a.Components {
			if strings.HasPrefix(c.Type, "state.") {
				stores = append(stores, c.Name)
			}
		}
		if appRunning(a) {
			running = append(running, a.AppID)
		}
	}
	sort.Strings(ids)
	sort.Strings(paths)
	sort.Strings(stores)
	sort.Strings(running)

	// Sentinel bytes keep the encoding unambiguous: every item is terminated by
	// 0x00 and every group boundary is a bare 0x01, so a group separator can
	// never hash like a real item (a string item is always followed by 0x00).
	// Fingerprints are compared only in-memory within one process run (rc.fp),
	// never persisted, so changing the encoding is safe.
	h := sha256.New()
	for gi, group := range [][]string{ids, paths, stores, running} {
		if gi > 0 {
			h.Write([]byte{1})
		}
		for _, s := range group {
			h.Write([]byte(s))
			h.Write([]byte{0})
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}
