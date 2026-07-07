package server

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/controlplane"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// Options configures the HTTP router.
type Options struct {
	BasePath string // "" or e.g. "/dashboard"
	DistFS   fs.FS  // embedded SPA assets (contains index.html)
	Version  version.Info
	Apps     discovery.Service
	// ContainerLogs streams container logs for compose-discovered apps.
	// nil disables container log streaming (404 for those apps).
	ContainerLogs func(ctx context.Context, containerID string) (<-chan string, error)
	Backend       WorkflowBackend
	Stores        StoreRegistry
	Resources     resources.Service
	News          news.Service
	ControlPlane  controlplane.Manager
	// TelemetryEnabled controls whether the served SPA loads Datadog RUM.
	TelemetryEnabled bool
}

// NewRouter wires the API and the embedded SPA under the optional base path.
func NewRouter(opts Options) http.Handler {
	base := "/" + strings.Trim(opts.BasePath, "/")
	base = strings.TrimSuffix(base, "/") // "" stays ""

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(localhostGuard)

	mount := func(router chi.Router) {
		router.Mount("/api", apiRouter(opts.Version, opts.Apps, opts.ContainerLogs, opts.Backend, opts.Stores, opts.Resources, opts.News, opts.ControlPlane))
		router.Handle("/*", SPAHandler(opts.DistFS, opts.BasePath, opts.TelemetryEnabled))
	}

	if base == "" {
		mount(r)
	} else {
		r.Route(base, func(sub chi.Router) { mount(sub) })
	}
	slog.Default().With("component", "server").Info("serving embedded UI", "basePath", opts.BasePath)
	return r
}

// Server owns the http.Server lifecycle.
type Server struct {
	http *http.Server
}

// New builds a Server listening on addr.
func New(addr string, opts Options) *Server {
	return &Server{http: &http.Server{
		Addr:              addr,
		Handler:           NewRouter(opts),
		ReadHeaderTimeout: 5 * time.Second,
	}}
}

// Start blocks serving until the server is shut down.
func (s *Server) Start() error {
	if err := s.http.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// Shutdown gracefully stops the server.
func (s *Server) Shutdown(ctx context.Context) error { return s.http.Shutdown(ctx) }
