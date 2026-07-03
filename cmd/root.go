// Package cmd wires the dev-dashboard CLI.
package cmd

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/logging"
	"github.com/diagridio/dev-dashboard/pkg/metadata"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/diagridio/dev-dashboard/web"
	"github.com/spf13/cobra"
)

// NewRootCmd builds the root command (default action = serve).
func NewRootCmd() *cobra.Command {
	var (
		port       int
		basePath   string
		noOpen     bool
		stateStore string
		namespace  string
		verbose    bool
	)
	info := version.Get()
	c := &cobra.Command{
		Use:           "dev-dashboard",
		Short:         "Local dashboard for Dapr apps, workflows, and sidecars",
		Version:       info.Version,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServe(cmd.Context(), port, basePath, noOpen, stateStore, namespace, verbose)
		},
	}
	c.SetVersionTemplate(fmt.Sprintf("dev-dashboard {{.Version}} (commit %s, built %s)\n", info.Commit, info.Date))
	c.Flags().IntVar(&port, "port", 9090, "port to serve the dashboard on")
	c.Flags().StringVar(&basePath, "base-path", "", "optional base path (e.g. /dashboard)")
	c.Flags().BoolVar(&noOpen, "no-open", false, "do not open the browser on start")
	c.Flags().StringVar(&stateStore, "statestore", "", "path to a state-store component YAML (overrides auto-detect)")
	c.Flags().StringVar(&namespace, "namespace", "default", "Dapr namespace for workflow keys")
	c.Flags().BoolVar(&verbose, "verbose", false, "enable diagnostic logging to stderr")
	c.AddCommand(newUpdateCmd())
	return c
}

// Execute runs the CLI.
func Execute() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return NewRootCmd().ExecuteContext(ctx)
}

func runServe(ctx context.Context, port int, basePath string, noOpen bool, stateStore, namespace string, verbose bool) error {
	logger := logging.New(verbose)
	slog.SetDefault(logger)

	dist, err := web.DistFS()
	if err != nil {
		logger.Error("embedded UI failed to load", "err", err)
		return fmt.Errorf("load embedded UI: %w", err)
	}
	if err := metadata.Init(); err != nil {
		logger.Error("component metadata bundle failed to load", "err", err)
		return fmt.Errorf("init component metadata: %w", err)
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	urlPath := ""
	if trimmed := trimSlash(basePath); trimmed != "" {
		urlPath = "/" + trimmed
	}
	url := fmt.Sprintf("http://%s%s/", addr, urlPath)

	home, err := os.UserHomeDir()
	if err != nil {
		// An empty home disables registry persistence in assembleOptions rather
		// than falling back to a CWD-relative registry path.
		logger.Warn("home directory unavailable; connection registry will not be persisted", "err", err)
		home = ""
	}
	opts, closers := assembleOptions(ctx, serveDeps{
		BasePath:       basePath,
		StateStorePath: stateStore,
		Namespace:      namespace,
		Apps:           discovery.New(discovery.StandaloneScanner(), &http.Client{Timeout: 2 * time.Second}),
		HomeDir:        home,
		HTTPClient:     &http.Client{Timeout: 10 * time.Second},
	}, dist)
	for _, close := range closers {
		close := close
		defer func() { _ = close() }()
	}

	srv := server.New(addr, opts)

	fmt.Printf("dev-dashboard %s → %s\n", version.Get().Version, url)
	if !noOpen {
		go func() { time.Sleep(400 * time.Millisecond); _ = openBrowser(url) }()
	}

	logger.Info("server listening", "addr", addr, "basePath", basePath, "version", version.Get().Version)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Start() }()

	select {
	case err := <-errCh:
		logger.Error("server failed to start", "addr", addr, "err", err)
		return err
	case <-ctx.Done():
		logger.Info("shutdown signal received")
		fmt.Println("shutting down…")
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutCtx); err != nil {
			logger.Warn("graceful shutdown failed", "err", err)
			return err
		}
		return nil
	}
}

func trimSlash(s string) string {
	for len(s) > 0 && s[0] == '/' {
		s = s[1:]
	}
	return s
}

// openBrowser launches the platform browser opener without blocking the
// caller. The child is reaped in a background goroutine (Start without Wait
// would leave a zombie until the dashboard exits); the error return reflects
// only whether the launch succeeded, as before.
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
