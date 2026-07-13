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
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
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

// TestAssembleOptionsPropagatesUpdateCheck verifies that serveDeps.UpdateCheck
// is threaded into server.Options.UpdateCheck unchanged, so runServe's
// startup-notice service and the server's /api/update-check endpoint share the
// same warmed cache instance.
func TestAssembleOptionsPropagatesUpdateCheck(t *testing.T) {
	uc := updatecheck.New(nil, "https://api.github.com", "diagridio/dev-dashboard", "1.2.0", time.Hour)
	opts, closers := assembleOptions(context.Background(), serveDeps{
		Apps:        emptyApps{},
		UpdateCheck: uc,
	}, nil)
	for _, c := range closers {
		defer func(c func() error) { _ = c() }(c)
	}
	require.Same(t, uc, opts.UpdateCheck)
}

// TestTCExtraResources_AdaptsExtractedFiles verifies the tcExtraResources
// adapter: a source with no runner (thus no extracted files) yields no
// extras, and the mapping contract it relies on — FromRaw producing a
// Resource keyed by the container-prefixed display path — is pinned directly.
func TestTCExtraResources_AdaptsExtractedFiles(t *testing.T) {
	// A TestcontainersSource whose fake runner serves one daprd container
	// with a resources tar — reuse the discovery test fixtures via a tiny
	// local stand-in instead: tcExtraResources only needs Files(), so give
	// it a source primed by a fake scan. Simplest honest setup: construct
	// the source against a fake runner exactly as pkg/discovery tests do is
	// not possible from cmd (fakeCRT is package-private), so this test uses
	// a real TestcontainersSource with a nil runner (no files) plus a unit
	// test of the adapter's mapping via FromRaw directly:
	src := discovery.NewTestcontainersSource(nil)
	extras := tcExtraResources(src)
	require.Empty(t, extras()) // nil runner -> no files -> no extras

	// Mapping contract is pinned at the resources level:
	rs := resources.FromRaw("crazy_lamport:/dapr-resources/kvstore.yaml",
		[]byte("kind: Component\nmetadata:\n  name: kvstore\nspec:\n  type: state.in-memory\n"))
	require.Len(t, rs, 1)
	require.Equal(t, "crazy_lamport:/dapr-resources/kvstore.yaml", rs[0].Path)
}

// TestVirtualPathsDoNotFeedStoreDetection guards the spec's isolation rule:
// container-prefixed virtual resource paths must be harmless no-ops for
// state-store detection (they are not host paths).
func TestVirtualPathsDoNotFeedStoreDetection(t *testing.T) {
	comps, err := statestore.Detect([]string{"crazy_lamport:/dapr-resources"})
	require.NoError(t, err)
	require.Empty(t, comps)
}
