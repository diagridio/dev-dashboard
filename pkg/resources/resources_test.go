//go:build unit

package resources

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

const compYAML = "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: statestore\nspec:\n  type: state.redis\n  version: v1\n"
const cfgYAML = "apiVersion: dapr.io/v1alpha1\nkind: Configuration\nmetadata:\n  name: appconfig\nspec:\n  tracing:\n    samplingRate: \"1\"\n"

func TestResourcesListAndGet(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(compYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "appconfig.yaml"), []byte(cfgYAML), 0o600))
	svc := New([]string{dir})

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 1)
	require.Equal(t, "statestore", comps[0].Name)
	require.Equal(t, "state.redis", comps[0].Type)
	require.Empty(t, comps[0].Raw) // List does not include raw

	cfgs, err := svc.List(context.Background(), KindConfiguration)
	require.NoError(t, err)
	require.Len(t, cfgs, 1)
	require.Equal(t, "appconfig", cfgs[0].Name)

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Contains(t, got.Raw, "state.redis")

	_, err = svc.Get(context.Background(), KindComponent, "missing")
	require.ErrorIs(t, err, ErrNotFound)
}
