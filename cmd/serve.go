package cmd

import (
	"context"
	"io/fs"
	"net/http"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/server"
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

	// Build the reconciler that owns all apps-derived state (resource paths,
	// detected state stores, active-store election, live workflow DB connection).
	rc := newReconciler(appsSvc, deps.Namespace, deps.HomeDir, deps.StateStorePath, deps.HTTPClient)

	// Seed once synchronously from the boot snapshot so the first request is
	// correct. Best-effort: an empty/failed list yields an empty derived state.
	var apps []discovery.Instance
	if got, err := appsSvc.List(ctx); err == nil {
		apps = got
	}
	rc.reconcile(apps, appsFingerprint(apps))

	// The decorator fires a fingerprint-gated reconcile on every /api/apps poll.
	decorated := reconcilingApps{inner: appsSvc, rc: rc}

	newsSvc := news.New(&http.Client{Timeout: 5 * time.Second}, "https://www.diagrid.io/api/product-feed", time.Hour)

	return server.Options{
		BasePath:  deps.BasePath,
		DistFS:    dist,
		Version:   version.Get(),
		Apps:      decorated,
		Backend:   rc,
		Stores:    rc,
		Resources: resources.New(rc.Paths),
		News:      newsSvc,
	}, []func() error{rc.Close}
}
