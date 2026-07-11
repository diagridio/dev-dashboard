//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func TestDerivePaths_AutoDetect(t *testing.T) {
	apps := []discovery.Instance{
		{AppID: "order", ResourcePaths: []string{"/app/resources"}, ConfigPath: "/app/config/cfg.yaml",
			Components: []discovery.Component{{Name: "statestore", Type: "state.redis"}}},
	}
	resPaths, scanPaths, loaded, _ := derivePaths(apps, "/home/me", "", nil)

	require.Contains(t, resPaths, "/home/me/.dapr/components")
	require.Contains(t, resPaths, "/home/me/.dapr")
	require.Contains(t, resPaths, "/app/resources")
	require.Contains(t, resPaths, "/app/config") // dir of ConfigPath

	require.Contains(t, scanPaths, "/home/me/.dapr/components")
	require.Contains(t, scanPaths, "/app/resources")
	require.NotContains(t, scanPaths, "/home/me/.dapr") // scanPaths is components + app paths only

	require.True(t, loaded["statestore"])
}

func TestDerivePaths_ExplicitStateStoreOverride(t *testing.T) {
	apps := []discovery.Instance{{AppID: "order", ResourcePaths: []string{"/app/resources"}}}
	_, scanPaths, _, _ := derivePaths(apps, "/home/me", "/explicit/store.yaml", nil)
	require.Equal(t, []string{"/explicit/store.yaml"}, scanPaths)
}

func TestDerivePaths_AppPaths(t *testing.T) {
	apps := []discovery.Instance{
		{AppID: "a", ResourcePaths: []string{"/app/a/resources"}},
		{AppID: "b", ResourcePaths: []string{"/app/b/resources"}},
	}
	_, _, _, appPaths := derivePaths(apps, "/home/me", "", nil)
	require.ElementsMatch(t, []string{"/app/a/resources", "/app/b/resources"}, appPaths)
	require.NotContains(t, appPaths, "/home/me/.dapr/components")
}

func TestAppsFingerprint_StableAndChangeSensitive(t *testing.T) {
	a := []discovery.Instance{
		{AppID: "b", ResourcePaths: []string{"/p2"}, Components: []discovery.Component{{Name: "s", Type: "state.redis"}}},
		{AppID: "a", ResourcePaths: []string{"/p1"}},
	}
	// Same content, different order -> same fingerprint.
	b := []discovery.Instance{
		{AppID: "a", ResourcePaths: []string{"/p1"}},
		{AppID: "b", ResourcePaths: []string{"/p2"}, Components: []discovery.Component{{Name: "s", Type: "state.redis"}}},
	}
	require.Equal(t, appsFingerprint(a), appsFingerprint(b))

	// New app -> different fingerprint.
	c := append([]discovery.Instance{{AppID: "c"}}, a...)
	require.NotEqual(t, appsFingerprint(a), appsFingerprint(c))

	// Same apps, new loaded state store -> different fingerprint.
	d := []discovery.Instance{
		{AppID: "a", ResourcePaths: []string{"/p1"}, Components: []discovery.Component{{Name: "x", Type: "state.redis"}}},
		{AppID: "b", ResourcePaths: []string{"/p2"}, Components: []discovery.Component{{Name: "s", Type: "state.redis"}}},
	}
	require.NotEqual(t, appsFingerprint(a), appsFingerprint(d))
}

// TestAppsFingerprint_GroupSeparatorNotConfusableWithItems covers the
// separator-collision case: under the old scheme the group separators
// ("|paths|" / "|stores|") were hashed exactly like real items, so an app with
// a resource path literally named "|stores|" fingerprinted identically to an
// app with a state store named "|stores|". Group boundaries must be encoded
// unambiguously so these two inputs produce distinct fingerprints.
func TestAppsFingerprint_GroupSeparatorNotConfusableWithItems(t *testing.T) {
	pathItem := []discovery.Instance{
		{AppID: "x", ResourcePaths: []string{"|stores|"}},
	}
	storeItem := []discovery.Instance{
		{AppID: "x", Components: []discovery.Component{{Name: "|stores|", Type: "state.redis"}}},
	}
	require.NotEqual(t, appsFingerprint(pathItem), appsFingerprint(storeItem),
		"a path item must never hash like a group boundary + store item")

	// Same trick on the ids/paths boundary: an app ID literally "|paths|" must
	// not collide with a path item "|paths|".
	idItem := []discovery.Instance{
		{AppID: "x"}, {AppID: "|paths|"},
	}
	pathNamedItem := []discovery.Instance{
		{AppID: "x", ResourcePaths: []string{"|paths|"}},
	}
	require.NotEqual(t, appsFingerprint(idItem), appsFingerprint(pathNamedItem),
		"an id item must never hash like a group boundary + path item")
}

func TestDerivePathsExtraResPaths(t *testing.T) {
	resPaths, scanPaths, _, _ := derivePaths(nil, "", "/app/components/state.yaml", []string{"/app/components"})
	found := false
	for _, p := range resPaths {
		if p == "/app/components" {
			found = true
		}
	}
	if !found {
		t.Fatalf("resPaths missing extra path: %v", resPaths)
	}
	if len(scanPaths) != 1 || scanPaths[0] != "/app/components/state.yaml" {
		t.Fatalf("explicit statestore must own scanPaths: %v", scanPaths)
	}
}
