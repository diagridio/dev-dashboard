//go:build unit

package cmd

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/stretchr/testify/require"
)

const secretStoreYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: localsecretstore
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: secrets.json
`

// Regression: --statestore used to collapse the scan path set to a single YAML,
// which made secret-store detection find nothing at all. Secret detection now
// runs over resPaths (the full resource path set), so the flag cannot disable it.
func TestSecretStoresDetectedWithExplicitStatestorePath(t *testing.T) {
	home := t.TempDir()
	compDir := filepath.Join(home, ".dapr", "components")
	require.NoError(t, os.MkdirAll(compDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(compDir, "secretstore.yaml"), []byte(secretStoreYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(compDir, "secrets.json"), []byte(`{"pw":"v"}`), 0o600))

	explicit := filepath.Join(home, "explicit-statestore.yaml")
	require.NoError(t, os.WriteFile(explicit, []byte("kind: Component\nmetadata:\n  name: s\nspec:\n  type: state.redis\n"), 0o600))

	resPaths, scanPaths, _, _ := derivePaths(nil, home, explicit, nil)
	require.Equal(t, []string{explicit}, scanPaths, "state-store scanning is still narrowed by the flag")

	svc := secrets.New(func() []string { return resPaths })
	require.Len(t, svc.Stores(context.Background()), 1, "secret detection must not be narrowed by --statestore")
}

// Regression: a secret store outside ~/.dapr/components but inside ~/.dapr was
// listed by the Components page yet invisible to the resolver.
func TestSecretStoreUnderDaprHomeIsDetected(t *testing.T) {
	home := t.TempDir()
	resDir := filepath.Join(home, ".dapr", "resources")
	require.NoError(t, os.MkdirAll(resDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(resDir, "secretstore.yaml"), []byte(secretStoreYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(resDir, "secrets.json"), []byte(`{"pw":"v"}`), 0o600))

	resPaths, _, _, _ := derivePaths([]discovery.Instance{}, home, "", nil)
	svc := secrets.New(func() []string { return resPaths })
	stores := svc.Stores(context.Background())
	require.Len(t, stores, 1)
	require.Equal(t, "localsecretstore", stores[0].Name)
	require.Empty(t, stores[0].InitErr)
}
