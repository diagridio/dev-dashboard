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
const subYAML = "apiVersion: dapr.io/v2alpha1\nkind: Subscription\nmetadata:\n  name: orders-sub\nspec:\n  topic: orders\n  routes:\n    default: /orders\n  pubsubname: pubsub\n"

func TestResourcesListAndGet(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(compYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "appconfig.yaml"), []byte(cfgYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "orders-sub.yaml"), []byte(subYAML), 0o600))
	svc := New(func() []string { return []string{dir} })

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

const comp2YAML = "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: pubsub\nspec:\n  type: pubsub.redis\n  version: v1\n"

func TestResourcesMultiDocFile(t *testing.T) {
	dir := t.TempDir()
	multi := comp2YAML + "---\n" + cfgYAML + "---\n" + compYAML
	require.NoError(t, os.WriteFile(filepath.Join(dir, "resources.yaml"), []byte(multi), 0o600))
	svc := New(func() []string { return []string{dir} })

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 2)
	require.Equal(t, "pubsub", comps[0].Name)
	require.Equal(t, "pubsub.redis", comps[0].Type)
	require.Equal(t, "statestore", comps[1].Name)
	require.Equal(t, "state.redis", comps[1].Type)

	cfgs, err := svc.List(context.Background(), KindConfiguration)
	require.NoError(t, err)
	require.Len(t, cfgs, 1)
	require.Equal(t, "appconfig", cfgs[0].Name)

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Contains(t, got.Raw, "state.redis")
}

func TestResourcesStableIDsAndDuplicateNames(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	// Two components sharing metadata.name "statestore" in different files.
	require.NoError(t, os.WriteFile(filepath.Join(dirA, "statestore.yaml"), []byte(compYAML), 0o600))
	dupYAML := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: statestore\nspec:\n  type: state.sqlite\n  version: v1\n"
	require.NoError(t, os.WriteFile(filepath.Join(dirB, "statestore.yaml"), []byte(dupYAML), 0o600))
	svc := New(func() []string { return []string{dirA, dirB} })

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 2, "duplicate names must both be listed")
	require.NotEmpty(t, comps[0].ID)
	require.NotEmpty(t, comps[1].ID)
	require.NotEqual(t, comps[0].ID, comps[1].ID, "distinct files get distinct ids")
	require.Len(t, comps[0].ID, 12, "id mirrors the registry's 12-char entryID shape")
	require.Less(t, comps[0].Path, comps[1].Path, "equal names sort by path")

	// IDs are stable across scans.
	again, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Equal(t, comps[0].ID, again[0].ID)

	// Get by ID returns the exact file, even for the name-collision loser.
	got, err := svc.Get(context.Background(), KindComponent, comps[1].ID)
	require.NoError(t, err)
	require.Equal(t, comps[1].Path, got.Path)
	require.Contains(t, got.Raw, "state.sqlite")

	// Get by name still works (first match) for old deep links.
	byName, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Equal(t, comps[0].Path, byName.Path)

	// Unknown id-or-name -> ErrNotFound.
	_, err = svc.Get(context.Background(), KindComponent, "nosuchthing")
	require.ErrorIs(t, err, ErrNotFound)
}
