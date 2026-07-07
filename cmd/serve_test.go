//go:build unit

package cmd

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

// emptyApps is a discovery.Service double with no running apps (unit-tag
// counterpart of the integration-only wiringFakeApps).
type emptyApps struct{}

func (emptyApps) List(context.Context) ([]discovery.Instance, error) { return nil, nil }
func (emptyApps) Get(context.Context, string) (discovery.Instance, error) {
	return discovery.Instance{}, discovery.ErrNotFound
}

// TestAssembleOptions_NoHomeDir_NoCWDRelativeRegistry verifies issue 1: when
// the home directory is unknown (HomeDir == ""), the connection registry must
// degrade to in-memory-only. It must NOT fall back to the relative path
// ".dapr/dev-dashboard/connections.yaml", which would silently fork the
// registry per working directory.
func TestAssembleOptions_NoHomeDir_NoCWDRelativeRegistry(t *testing.T) {
	tmp := t.TempDir()
	t.Chdir(tmp)

	opts, closers := assembleOptions(context.Background(), serveDeps{
		Namespace:  "default",
		Apps:       emptyApps{},
		HomeDir:    "",
		HTTPClient: &http.Client{Timeout: time.Second},
	}, fstest.MapFS{})
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	// A store mutation must not create .dapr relative to the CWD.
	require.NoError(t, opts.Stores.AddStore("mem", "state.sqlite",
		map[string]string{"connectionString": filepath.Join(tmp, "mem.db")}))

	_, err := os.Stat(filepath.Join(tmp, ".dapr"))
	require.True(t, os.IsNotExist(err),
		"no .dapr directory may be created relative to the CWD when the home dir is unknown")
}

// TestAssembleOptions_TelemetryEnabledPassedThrough verifies that
// serveDeps.TelemetryEnabled is threaded into server.Options.TelemetryEnabled
// unchanged.
func TestAssembleOptions_TelemetryEnabledPassedThrough(t *testing.T) {
	opts, closers := assembleOptions(context.Background(), serveDeps{
		Namespace:        "default",
		Apps:             emptyApps{},
		HomeDir:          "",
		HTTPClient:       &http.Client{Timeout: time.Second},
		TelemetryEnabled: true,
	}, fstest.MapFS{})
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	require.True(t, opts.TelemetryEnabled)
}
