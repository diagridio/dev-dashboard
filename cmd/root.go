// Package cmd wires the dev-dashboard CLI.
package cmd

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/diagridio/dev-dashboard/web"
	"github.com/spf13/cobra"
)

// NewRootCmd builds the root command (default action = serve).
func NewRootCmd() *cobra.Command {
	var (
		port     int
		basePath string
		noOpen   bool
	)
	c := &cobra.Command{
		Use:           "dev-dashboard",
		Short:         "Local dashboard for Dapr apps, workflows, and sidecars",
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServe(cmd.Context(), port, basePath, noOpen)
		},
	}
	c.Flags().IntVar(&port, "port", 9090, "port to serve the dashboard on")
	c.Flags().StringVar(&basePath, "base-path", "", "optional base path (e.g. /dashboard)")
	c.Flags().BoolVar(&noOpen, "no-open", false, "do not open the browser on start")
	return c
}

// Execute runs the CLI.
func Execute() error { return NewRootCmd().ExecuteContext(context.Background()) }

func runServe(ctx context.Context, port int, basePath string, noOpen bool) error {
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

	srv := server.New(addr, server.Options{
		BasePath: basePath,
		DistFS:   dist,
		Version:  version.Get(),
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
