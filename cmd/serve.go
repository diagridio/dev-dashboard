package cmd

import (
	"context"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/version"
)

// serveDeps holds the inputs needed to assemble the server's dependency graph.
// Apps and HomeDir are injectable so tests can avoid real process scanning and
// the real ~/.dapr directory.
type serveDeps struct {
	BasePath       string
	StateStorePath string // explicit component YAML; "" means auto-detect
	Namespace      string
	Apps           discovery.Service
	HomeDir        string
	HTTPClient     *http.Client // workflow HTTP client (remover/purge)
}

// assembleOptions builds server.Options and the matching store closers from deps.
// The caller owns invoking the returned closers.
func assembleOptions(ctx context.Context, deps serveDeps, dist fs.FS) (server.Options, []func() error) {
	appsSvc := deps.Apps

	// Fetch running apps once (best-effort), reused for store-path scanning, the
	// resources loader, and the app-loaded component-name set.
	var apps []discovery.Instance
	if got, err := appsSvc.List(ctx); err == nil {
		apps = got
	}

	// loaded = state-store component names that at least one running app loaded.
	loaded := make(map[string]bool)
	for _, a := range apps {
		for _, c := range a.Components {
			if strings.HasPrefix(c.Type, "state.") {
				loaded[c.Name] = true
			}
		}
	}

	// Resolve resource paths to scan for state-store components.
	var scanPaths []string
	if deps.StateStorePath != "" {
		scanPaths = []string{deps.StateStorePath}
	} else {
		if deps.HomeDir != "" {
			scanPaths = append(scanPaths, filepath.Join(deps.HomeDir, ".dapr", "components"))
		}
		for _, a := range apps {
			scanPaths = append(scanPaths, a.ResourcePaths...)
		}
	}
	detected, _ := statestore.Detect(scanPaths)
	registry := newStoreRegistry(detected, loaded)

	// Resolve resource paths for the resources loader.
	var resPaths []string
	if deps.HomeDir != "" {
		resPaths = append(resPaths, filepath.Join(deps.HomeDir, ".dapr", "components"), filepath.Join(deps.HomeDir, ".dapr"))
	}
	for _, a := range apps {
		resPaths = append(resPaths, a.ResourcePaths...)
		if a.ConfigPath != "" {
			resPaths = append(resPaths, filepath.Dir(a.ConfigPath))
		}
	}
	resSvc := resources.New(func() []string { return resPaths })

	appIDs := func(ctx context.Context) ([]string, error) {
		apps, err := appsSvc.List(ctx)
		if err != nil {
			return nil, err
		}
		ids := make([]string, 0, len(apps))
		for _, a := range apps {
			ids = append(ids, a.AppID)
		}
		return ids, nil
	}

	backend, closers := newStoreBackend(ctx, detected, loaded, deps.Namespace, deps.HTTPClient, appsSvc, appIDs, statestore.New)
	newsSvc := news.New(&http.Client{Timeout: 5 * time.Second}, "https://www.diagrid.io/api/product-feed", time.Hour)

	return server.Options{
		BasePath:  deps.BasePath,
		DistFS:    dist,
		Version:   version.Get(),
		Apps:      appsSvc,
		Backend:   backend,
		Stores:    registry,
		Resources: resSvc,
		News:      newsSvc,
	}, closers
}
