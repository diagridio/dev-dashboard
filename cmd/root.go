// Package cmd wires the dev-dashboard CLI.
package cmd

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
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
	)
	c := &cobra.Command{
		Use:           "dev-dashboard",
		Short:         "Local dashboard for Dapr apps, workflows, and sidecars",
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServe(cmd.Context(), port, basePath, noOpen, stateStore, namespace)
		},
	}
	c.Flags().IntVar(&port, "port", 9090, "port to serve the dashboard on")
	c.Flags().StringVar(&basePath, "base-path", "", "optional base path (e.g. /dashboard)")
	c.Flags().BoolVar(&noOpen, "no-open", false, "do not open the browser on start")
	c.Flags().StringVar(&stateStore, "statestore", "", "path to a state-store component YAML (overrides auto-detect)")
	c.Flags().StringVar(&namespace, "namespace", "default", "Dapr namespace for workflow keys")
	return c
}

// Execute runs the CLI.
func Execute() error { return NewRootCmd().ExecuteContext(context.Background()) }

func runServe(ctx context.Context, port int, basePath string, noOpen bool, stateStore, namespace string) error {
	dist, err := web.DistFS()
	if err != nil {
		return fmt.Errorf("load embedded UI: %w", err)
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	urlPath := ""
	if trimmed := trimSlash(basePath); trimmed != "" {
		urlPath = "/" + trimmed
	}
	url := fmt.Sprintf("http://%s%s/", addr, urlPath)

	appsSvc := discovery.New(discovery.StandaloneScanner(), &http.Client{Timeout: 2 * time.Second})

	// Resolve resource paths to scan for state-store components.
	var scanPaths []string
	if stateStore != "" {
		scanPaths = []string{stateStore}
	} else {
		// default Dapr components dir + any live --resources-path from running apps
		if home, err := os.UserHomeDir(); err == nil {
			scanPaths = append(scanPaths, filepath.Join(home, ".dapr", "components"))
		}
		if apps, err := appsSvc.List(ctx); err == nil {
			for _, a := range apps {
				scanPaths = append(scanPaths, a.ResourcePaths...)
			}
		}
	}
	detected, _ := statestore.Detect(scanPaths)
	registry := newStoreRegistry(detected)

	// Resolve resource paths for the resources loader (components, configs, subscriptions, etc.).
	var resPaths []string
	if home, err := os.UserHomeDir(); err == nil {
		resPaths = append(resPaths, filepath.Join(home, ".dapr", "components"), filepath.Join(home, ".dapr"))
	}
	if apps, err := appsSvc.List(ctx); err == nil {
		for _, a := range apps {
			resPaths = append(resPaths, a.ResourcePaths...)
			if a.ConfigPath != "" {
				resPaths = append(resPaths, filepath.Dir(a.ConfigPath))
			}
		}
	}
	resSvc := resources.New(resPaths)

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

	wfClient := &http.Client{Timeout: 10 * time.Second}
	backend, closers := newStoreBackend(ctx, detected, namespace, wfClient, appsSvc, appIDs)
	for _, close := range closers {
		close := close
		defer func() { _ = close() }()
	}

	srv := server.New(addr, server.Options{
		BasePath:  basePath,
		DistFS:    dist,
		Version:   version.Get(),
		Apps:      appsSvc,
		Backend:   backend,
		Stores:    registry,
		Resources: resSvc,
	})

	fmt.Printf("dev-dashboard %s → %s\n", version.Get().Version, url)
	if !noOpen {
		go func() { time.Sleep(400 * time.Millisecond); _ = openBrowser(url) }()
	}
	return srv.Start()
}

func trimSlash(s string) string {
	for len(s) > 0 && s[0] == '/' {
		s = s[1:]
	}
	return s
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
