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
func derivePaths(apps []discovery.Instance, homeDir, stateStorePath string) (resPaths, scanPaths []string, loaded map[string]bool, appPaths []string) {
	loaded = make(map[string]bool)
	for _, a := range apps {
		for _, c := range a.Components {
			if strings.HasPrefix(c.Type, "state.") {
				loaded[c.Name] = true
			}
		}
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
	return resPaths, scanPaths, loaded, appPaths
}

// appsFingerprint hashes the apps-derived inputs that the reconciler depends on:
// the set of app IDs, the list (multiset, no dedup) of resource paths +
// config-file dirs, and the set of loaded state-store component names.
// Deduplication of paths happens downstream in statestore.Detect.
// Order-independent: same content yields the same fingerprint regardless of
// app ordering.
func appsFingerprint(apps []discovery.Instance) string {
	var ids, paths, stores []string
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
	}
	sort.Strings(ids)
	sort.Strings(paths)
	sort.Strings(stores)

	h := sha256.New()
	for _, group := range [][]string{ids, {"|paths|"}, paths, {"|stores|"}, stores} {
		for _, s := range group {
			h.Write([]byte(s))
			h.Write([]byte{0})
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}
