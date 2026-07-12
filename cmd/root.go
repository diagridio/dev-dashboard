// Package cmd wires the dev-dashboard CLI.
package cmd

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/lifecycle"
	"github.com/diagridio/dev-dashboard/pkg/logging"
	"github.com/diagridio/dev-dashboard/pkg/metadata"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/diagridio/dev-dashboard/web"
	"github.com/mattn/go-isatty"
	"github.com/spf13/cobra"
)

// NewRootCmd builds the root command (default action = serve).
func NewRootCmd() *cobra.Command {
	var (
		port       int
		bind       string
		modeFlag   string
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
			mode, err := resolveMode(modeFlag, os.Getenv)
			if err != nil {
				return err
			}
			settings, err := resolveServeSettings(mode, cmd.Flags().Changed, port, bind, stateStore, namespace, os.Getenv)
			if err != nil {
				return err
			}
			return runServe(cmd.Context(), mode, settings, basePath, noOpen, verbose)
		},
	}
	c.SetVersionTemplate(fmt.Sprintf("dev-dashboard {{.Version}} (commit %s, built %s)\n", info.Commit, info.Date))
	c.Flags().IntVar(&port, "port", 9090, "port to serve the dashboard on")
	c.Flags().StringVar(&bind, "bind", "127.0.0.1", "address to bind (aspire mode defaults to 0.0.0.0); binding a non-loopback address without aspire mode leaves the loopback Host guard in place, which rejects remote clients")
	c.Flags().StringVar(&modeFlag, "mode", "", `serving/discovery mode: "aspire", or unset for the complete scan`)
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

func runServe(ctx context.Context, mode Mode, settings serveSettings, basePath string, noOpen, verbose bool) error {
	logger := logging.New(verbose)
	slog.SetDefault(logger)
	statestore.SetVerbose(verbose)

	dist, err := web.DistFS()
	if err != nil {
		logger.Error("embedded UI failed to load", "err", err)
		return fmt.Errorf("load embedded UI: %w", err)
	}
	if err := metadata.Init(); err != nil {
		logger.Error("component metadata bundle failed to load", "err", err)
		return fmt.Errorf("init component metadata: %w", err)
	}
	addr := listenAddr(settings.Bind, settings.Port)
	if mode == ModeDefault && !isLoopbackBind(settings.Bind) {
		logger.Warn("binding a non-loopback address without aspire mode; the loopback Host guard will reject remote clients (set --mode aspire for container serving posture)", "bind", settings.Bind)
	}
	urlPath := ""
	if trimmed := trimSlash(basePath); trimmed != "" {
		urlPath = "/" + trimmed
	}
	displayHost := settings.Bind
	if displayHost == "0.0.0.0" || displayHost == "::" {
		displayHost = "localhost"
	}
	url := fmt.Sprintf("http://%s:%d%s/", displayHost, settings.Port, urlPath)

	// Aspire/container mode disables registry persistence entirely (no home
	// directory), so the "no home" warning is suppressed via QuietRegistry.
	home := ""
	if mode != ModeAspire {
		home, err = os.UserHomeDir()
		if err != nil {
			// An empty home disables registry persistence in assembleOptions rather
			// than falling back to a CWD-relative registry path.
			logger.Warn("home directory unavailable; connection registry will not be persisted", "err", err)
			home = ""
		}
	}

	client := &http.Client{Timeout: 2 * time.Second}
	var (
		appsSvc       discovery.Service
		lifeMgr       lifecycle.Manager
		composeEnv    func() discovery.ComposeEnv
		containerLogs func(context.Context, string) (<-chan string, error)
		updateCheck   updatecheck.Service
		caps          *server.Capabilities
	)
	switch mode {
	case ModeAspire:
		scan, err := discovery.NewAspireScanner(os.Getenv)
		if err != nil {
			return err
		}
		appsSvc = discovery.New(scan, client)
		caps = &server.Capabilities{Workflows: settings.StateStore != ""}
	default:
		_, crtRunner := containerruntime.Detect()
		composeSrc := discovery.NewComposeSource(crtRunner)
		scanners := []discovery.Scanner{discovery.StandaloneScanner(), composeSrc.Scanner()}
		if discovery.AspireContractPresent(os.Getenv) {
			as, err := discovery.NewAspireScanner(os.Getenv)
			if err != nil {
				return err
			}
			scanners = append(scanners, as)
		}
		lifeReg := lifecycle.NewRegistry()
		lifeProc := lifecycle.NewProcController()
		appsSvc = lifecycle.Overlay(
			discovery.New(discovery.Merge(scanners...), client), lifeReg, lifeProc)
		lifeMgr = lifecycle.New(appsSvc, lifeReg, crtRunner, lifeProc, lifecycle.NewStarter())
		composeEnv = composeSrc.Env
		containerLogs = containerLogStream(crtRunner)
		updateCheck = updatecheck.New(&http.Client{Timeout: 5 * time.Second}, "https://api.github.com", "diagridio/dev-dashboard", version.Get().Version, time.Hour)
	}

	telemetry := telemetryEnabled(os.Getenv)
	opts, closers := assembleOptions(ctx, serveDeps{
		BasePath:         basePath,
		StateStorePath:   settings.StateStore,
		Namespace:        settings.Namespace,
		Apps:             appsSvc,
		Lifecycle:        lifeMgr,
		HomeDir:          home,
		HTTPClient:       &http.Client{Timeout: 10 * time.Second},
		ComposeEnv:       composeEnv,
		ContainerLogs:    containerLogs,
		TelemetryEnabled: telemetry,
		UpdateCheck:      updateCheck,
		AllowNonLoopback: mode == ModeAspire,
		AllowedHosts:     settings.AllowedHosts,
		ListenPort:       settings.Port,
		Capabilities:     caps,
		ResourcesPaths:   settings.ResourcesPaths,
		QuietRegistry:    mode == ModeAspire,
	}, dist)
	for _, close := range closers {
		close := close
		defer func() { _ = close() }()
	}

	srv := server.New(addr, opts)

	if updateCheck != nil {
		check := maybeAnnounceUpdate(ctx, updateCheck, version.Get().Version)
		interactive := isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd())
		maybeOfferUpdate(ctx, check, os.Stdin, os.Stdout, interactive, selfUpdateAndRestart)
	}
	fmt.Printf("Diagrid Dev Dashboard is starting → %s\n", url)
	if telemetry {
		fmt.Println("We're using anonymous usage telemetry to improve the dashboard. Set DEVDASHBOARD_TELEMETRY_OPTOUT=true to disable (restart required).")
	} else {
		fmt.Println("Anonymous usage telemetry is disabled (DEVDASHBOARD_TELEMETRY_OPTOUT=true).")
	}
	if !noOpen && mode != ModeAspire {
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

// telemetryEnabled reports whether RUM telemetry should run, based on the
// DEVDASHBOARD_TELEMETRY_OPTOUT env var. Read once at process start (via
// getenv) — restart the dashboard for a changed value to take effect.
func telemetryEnabled(getenv func(string) string) bool {
	return !strings.EqualFold(getenv("DEVDASHBOARD_TELEMETRY_OPTOUT"), "true")
}

// listenAddr joins a bind address and port into a listen address, correctly
// bracketing IPv6 literals (e.g. "::" -> "[::]:8080").
func listenAddr(bind string, port int) string {
	return net.JoinHostPort(bind, strconv.Itoa(port))
}

// isLoopbackBind reports whether a bind address is a loopback address the
// dashboard's loopback Host guard is designed for.
func isLoopbackBind(bind string) bool {
	switch bind {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
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
