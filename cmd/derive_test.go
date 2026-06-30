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
	resPaths, scanPaths, loaded, _ := derivePaths(apps, "/home/me", "")

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
	_, scanPaths, _, _ := derivePaths(apps, "/home/me", "/explicit/store.yaml")
	require.Equal(t, []string{"/explicit/store.yaml"}, scanPaths)
}

func TestDerivePaths_AppPaths(t *testing.T) {
	apps := []discovery.Instance{
		{AppID: "a", ResourcePaths: []string{"/app/a/resources"}},
		{AppID: "b", ResourcePaths: []string{"/app/b/resources"}},
	}
	_, _, _, appPaths := derivePaths(apps, "/home/me", "")
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
