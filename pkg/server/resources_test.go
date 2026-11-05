//go:build unit

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/stretchr/testify/require"
)

type fakeResources struct{ items []resources.Resource }

func (f fakeResources) List(_ context.Context, kind resources.Kind) ([]resources.Resource, error) {
	var out []resources.Resource
	for _, r := range f.items {
		if r.Kind == kind {
			out = append(out, r)
		}
	}
	return out, nil
}
func (f fakeResources) Get(_ context.Context, kind resources.Kind, name string) (resources.Resource, error) {
	for _, r := range f.items {
		if r.Kind == kind && r.Name == name {
			return r, nil
		}
	}
	return resources.Resource{}, resources.ErrNotFound
}
func (f fakeResources) RevealSecret(_ context.Context, _, _ string) (string, error) {
	return "", resources.ErrNoSecretValue
}

func TestResourcesListWithLoadedBy(t *testing.T) {
	res := fakeResources{items: []resources.Resource{{Name: "statestore", Kind: resources.KindComponent, Type: "state.redis"}}}
	apps := &fakeApps{instances: []discovery.Instance{{AppID: "order", Components: []discovery.Component{{Name: "statestore"}}}}}
	h := resourcesRouter(res, apps, false)

	r1, body := get(t, h, "/?kind=component")
	require.Equal(t, http.StatusOK, r1.StatusCode)
	require.Contains(t, body, `"name":"statestore"`)
	require.Contains(t, body, `"loadedBy":["order"]`)

	r2, _ := get(t, h, "/")
	require.Equal(t, http.StatusBadRequest, r2.StatusCode)

	r3, body3 := get(t, h, "/component/statestore")
	require.Equal(t, http.StatusOK, r3.StatusCode)
	require.Contains(t, body3, `"loadedBy":["order"]`)

	r4, _ := get(t, h, "/component/missing")
	require.Equal(t, http.StatusNotFound, r4.StatusCode)

	r5, body5 := get(t, h, "/badkind/foo")
	require.Equal(t, http.StatusBadRequest, r5.StatusCode)
	require.Contains(t, body5, `"error":"kind must be component, configuration or resiliency"`)
}

func TestLoadedByUsesInstanceKeys(t *testing.T) {
	res := fakeResources{items: []resources.Resource{{Name: "statestore", Kind: resources.KindComponent, Type: "state.postgresql"}}}
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-1", Components: []discovery.Component{{Name: "statestore"}}},
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-2", Components: []discovery.Component{{Name: "statestore"}}},
	}}
	h := resourcesRouter(res, apps, false)

	r1, body := get(t, h, "/component/statestore")
	require.Equal(t, http.StatusOK, r1.StatusCode)
	require.Contains(t, body, `"loadedBy":["daprmq-host-1","daprmq-host-2"]`)

	r2, body2 := get(t, h, "/?kind=component")
	require.Equal(t, http.StatusOK, r2.StatusCode)
	require.Contains(t, body2, `"loadedBy":["daprmq-host-1","daprmq-host-2"]`)
}

func TestResourcesListResiliency(t *testing.T) {
	res := fakeResources{items: []resources.Resource{{
		Name:   "party-api-resiliency",
		Kind:   resources.KindResiliency,
		Path:   "/proj/resources/common/resiliency.yaml",
		Scopes: []string{"party-api"},
		Resiliency: &resources.ResiliencySpec{
			Policies: resources.ResiliencyPolicies{Timeouts: map[string]string{"downstream": "2s"}},
			Targets: resources.ResiliencyTargets{Apps: map[string]resources.ResiliencyPolicyRefs{
				"party-registry": {Timeout: "downstream"},
			}},
		},
	}}}
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "party-api", Resiliencies: []discovery.Resiliency{{Name: "party-api-resiliency"}}},
		{AppID: "party-registry", Components: []discovery.Component{{Name: "party-api-resiliency"}}},
	}}
	h := resourcesRouter(res, apps, false)

	r1, body := get(t, h, "/?kind=resiliency")
	require.Equal(t, http.StatusOK, r1.StatusCode)
	require.Contains(t, body, `"name":"party-api-resiliency"`)
	require.Contains(t, body, `"scopes":["party-api"]`)
	require.Contains(t, body, `"timeouts":{"downstream":"2s"}`)
	require.Contains(t, body, `"apps":{"party-registry":{"timeout":"downstream"}}`)
	// Only sidecars reporting the policy under resiliencies count, not a
	// same-named component.
	require.Contains(t, body, `"loadedBy":["party-api"]`)

	r2, body2 := get(t, h, "/resiliency/party-api-resiliency")
	require.Equal(t, http.StatusOK, r2.StatusCode)
	require.Contains(t, body2, `"kind":"resiliency"`)
	require.Contains(t, body2, `"loadedBy":["party-api"]`)
}

func TestResourcesListConfigurationUsedBy(t *testing.T) {
	res := fakeResources{items: []resources.Resource{
		{Name: "party-api", Kind: resources.KindConfiguration, Path: "/proj/config/party-api.yaml"},
		{Name: "default", Kind: resources.KindConfiguration, Path: "/proj/config/default.yaml"},
		{Name: "daprConfig", Kind: resources.KindConfiguration, Path: "/home/me/.dapr/config.yaml"},
	}}
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "party-api", ConfigPath: "/proj/config/party-api.yaml"},
		// Not normalized on the instance side; still matches.
		{AppID: "party-registry", ConfigPath: "/proj/party-registry/../config/default.yaml"},
		{AppID: "notification", ConfigPath: "/proj/config/default.yaml"},
		// Same name as a configuration, different file: not a match.
		{AppID: "other", ConfigPath: "/elsewhere/party-api.yaml"},
	}}
	h := resourcesRouter(res, apps, false)

	r1, body := get(t, h, "/?kind=configuration")
	require.Equal(t, http.StatusOK, r1.StatusCode)
	var list []resources.Resource
	require.NoError(t, json.Unmarshal([]byte(body), &list))
	byName := map[string][]string{}
	for _, r := range list {
		byName[r.Name] = r.LoadedBy
	}
	require.Equal(t, []string{"party-api"}, byName["party-api"])
	require.Equal(t, []string{"notification", "party-registry"}, byName["default"])
	require.Empty(t, byName["daprConfig"])

	r2, body2 := get(t, h, "/configuration/default")
	require.Equal(t, http.StatusOK, r2.StatusCode)
	require.Contains(t, body2, `"loadedBy":["notification","party-registry"]`)
}

// An app whose --config path runs through a symlink still "uses" the
// configuration the loader found under the real path, on list and detail.
func TestConfigurationUsedByThroughSymlink(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	link := filepath.Join(base, "link")
	require.NoError(t, os.MkdirAll(real, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(real, "config.yaml"), []byte("kind: Configuration\n"), 0o600))
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	res := fakeResources{items: []resources.Resource{
		{Name: "appcfg", Kind: resources.KindConfiguration, Path: filepath.Join(real, "config.yaml")},
	}}
	apps := &fakeApps{instances: []discovery.Instance{{AppID: "a", ConfigPath: filepath.Join(link, "config.yaml")}}}
	h := resourcesRouter(res, apps, false)

	_, body := get(t, h, "/?kind=configuration")
	require.Contains(t, body, `"loadedBy":["a"]`)
	_, body2 := get(t, h, "/configuration/appcfg")
	require.Contains(t, body2, `"loadedBy":["a"]`)
}
