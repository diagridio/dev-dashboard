package cmd

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
	"github.com/diagridio/dev-dashboard/pkg/controlplane"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/lifecycle"
	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
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
	// Lifecycle starts/stops/restarts discovered apps; nil disables the actions
	// API (routes return 503).
	Lifecycle lifecycle.Manager
	// ControlPlane lists/controls the placement+scheduler services, already
	// filtered to the mode's families (cpSourcesFor).
	ControlPlane controlplane.Manager
	HomeDir      string
	HTTPClient   *http.Client // workflow HTTP client (remover/purge)
	// ComposeEnv returns the compose endpoint/mount context from the last
	// compose scan; nil when compose discovery is disabled (tests, no runtime).
	ComposeEnv func() discovery.ComposeEnv
	// ContainerLogs streams `docker logs -f` for a container id; nil when no
	// container runtime is available.
	ContainerLogs func(ctx context.Context, containerID string) (<-chan string, error)
	// TelemetryEnabled reflects DEVDASHBOARD_TELEMETRY_OPTOUT, read once at
	// process start in runServe.
	TelemetryEnabled bool
	// UpdateCheck is the shared latest-release checker; also used by runServe to
	// print the startup notice, so the server reuses its warmed cache.
	UpdateCheck updatecheck.Service
	// AllowNonLoopback relaxes the server's request guard from loopback-only to
	// any Host (aspire/container mode, where the dashboard is reached via a
	// published port).
	AllowNonLoopback bool
	// AllowedHosts restricts the Host header in container posture (loopback
	// always allowed); empty means any Host passes. From DEVDASHBOARD_ALLOWED_HOSTS.
	AllowedHosts []string
	// ListenPort is the server's listen port, used to normalize a portless Host
	// header when comparing Origin against Host in container posture.
	ListenPort int
	// Capabilities gates optional feature routes and SPA flags; nil means full
	// host-mode capabilities.
	Capabilities *server.Capabilities
	// ResourcesPaths are extra resource directories appended to the reconciler's
	// scan paths (aspire-mode DEVDASHBOARD_RESOURCES_PATH); nil in host mode.
	ResourcesPaths []string
	// QuietRegistry suppresses the "no home directory" registry-persistence
	// warning when persistence is deliberately disabled (aspire mode).
	QuietRegistry bool
	// AppNamespaces is the static appID→namespace map parsed once from the
	// aspire DEVDASHBOARD_APP_* env contract; nil when the contract is absent.
	// Workflow reads resolve per-app namespaces from it by map lookup, never
	// via discovery enrichment (sidecar probes).
	AppNamespaces map[string]string
	// ExtraResources supplies resource entries that exist outside the host
	// filesystem (testcontainers-extracted component YAML); nil when the
	// testcontainers scanner is disabled (aspire mode, tests).
	ExtraResources func() []resources.Resource
}

// tcExtraResources adapts the testcontainers scanner's extracted files into
// resources entries with container-prefixed display paths. The entries feed
// ONLY the resources service — never state-store detection or election (an
// extracted in-memory actor store would otherwise win the election).
func tcExtraResources(src *discovery.TestcontainersSource) func() []resources.Resource {
	return func() []resources.Resource {
		var out []resources.Resource
		for _, f := range src.Files() {
			out = append(out, resources.FromRaw(f.Container+":"+f.Path, f.Content)...)
		}
		return out
	}
}

// containerLogStream adapts a runtime Runner into the log-stream dependency.
// Returns nil (feature disabled) when run is nil.
func containerLogStream(run containerruntime.Runner) func(context.Context, string) (<-chan string, error) {
	if run == nil {
		return nil
	}
	return func(ctx context.Context, id string) (<-chan string, error) {
		return run.Stream(ctx, "logs", "-f", "--tail", "200", id)
	}
}

// assembleOptions builds server.Options and the matching store closers from deps.
// The caller owns invoking the returned closers.
func assembleOptions(ctx context.Context, deps serveDeps, dist fs.FS) (server.Options, []func() error) {
	appsSvc := deps.Apps

	// Load the persisted connection registry and build the lazy connection pool.
	// Without a home directory the registry path would resolve CWD-relative and
	// silently fork per working directory, so persistence is disabled instead:
	// a nil registry degrades every registry-backed feature to a no-op (the
	// reconciler nil-checks it throughout).
	var registry *ConnRegistry
	if deps.HomeDir != "" {
		registry = LoadRegistry(deps.HomeDir)
	} else if !deps.QuietRegistry {
		slog.Default().With("component", "registry").Warn("no home directory; connection registry persistence disabled")
	}
	pool := newConnPool(deps.Namespace, deps.HTTPClient, appsSvc, nil, deps.AppNamespaces)

	// Build the reconciler that owns all apps-derived state (resource paths,
	// detected state stores, active-store election) plus the registry and pool.
	rc := newReconciler(ctx, appsSvc, deps.Namespace, deps.HomeDir, deps.StateStorePath, deps.HTTPClient, registry, pool, deps.ComposeEnv, deps.ResourcesPaths)

	// Seed once synchronously from the boot snapshot so the first request is
	// correct. Best-effort: an empty/failed list yields an empty derived state.
	var apps []discovery.Instance
	if got, err := appsSvc.List(ctx); err == nil {
		apps = got
	}
	rc.reconcile(apps, appsFingerprint(apps))

	// The decorator fires a fingerprint-gated reconcile on every /api/apps poll.
	// Because decorated is shared as Options.Apps across all routers, any
	// caller of apps.List — /api/apps, /api/actors, /api/subscriptions,
	// /api/resources — drives the fingerprint-gated reconcile, not only /api/apps.
	decorated := reconcilingApps{inner: appsSvc, rc: rc}

	newsSvc := news.New(&http.Client{Timeout: 5 * time.Second}, "https://www.diagrid.io/api/product-feed", time.Hour)

	return server.Options{
		BasePath:         deps.BasePath,
		DistFS:           dist,
		Version:          version.Get(),
		Apps:             decorated,
		Lifecycle:        deps.Lifecycle,
		ContainerLogs:    deps.ContainerLogs,
		Backend:          rc,
		Stores:           rc,
		Resources:        resources.New(rc.Paths, deps.ExtraResources),
		News:             newsSvc,
		ControlPlane:     deps.ControlPlane,
		TelemetryEnabled: deps.TelemetryEnabled,
		UpdateCheck:      deps.UpdateCheck,
		AllowNonLoopback: deps.AllowNonLoopback,
		AllowedHosts:     deps.AllowedHosts,
		ListenPort:       deps.ListenPort,
		Capabilities:     deps.Capabilities,
	}, []func() error{rc.Close}
}
