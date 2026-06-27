//go:build unit

package server

import (
	"context"
	"net/http"
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

func TestResourcesListWithLoadedBy(t *testing.T) {
	res := fakeResources{items: []resources.Resource{{Name: "statestore", Kind: resources.KindComponent, Type: "state.redis"}}}
	apps := &fakeApps{instances: []discovery.Instance{{AppID: "order", Components: []discovery.Component{{Name: "statestore"}}}}}
	h := resourcesRouter(res, apps)

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
}
