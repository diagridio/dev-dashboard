//go:build unit

package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

// fakeApps is a test double for discovery.Service.
type fakeApps struct {
	instances []discovery.Instance
}

func (f *fakeApps) List(_ context.Context) ([]discovery.Instance, error) {
	return f.instances, nil
}

func (f *fakeApps) Get(_ context.Context, appID string) (discovery.Instance, error) {
	for _, inst := range f.instances {
		if inst.AppID == appID {
			return inst, nil
		}
	}
	return discovery.Instance{}, fmt.Errorf("%w: %s", discovery.ErrNotFound, appID)
}

var testInstances = []discovery.Instance{
	{AppID: "checkout", HTTPPort: 3000, Health: discovery.HealthHealthy},
	{AppID: "inventory", HTTPPort: 3001, Health: discovery.HealthUnknown},
}

func newFakeApps() *fakeApps {
	return &fakeApps{instances: testInstances}
}

func TestAppsListReturnsAllInstances(t *testing.T) {
	h := appsRouter(newFakeApps())
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "application/json", res.Header.Get("Content-Type"))

	var got []discovery.Instance
	require.NoError(t, json.Unmarshal([]byte(body), &got))
	require.Len(t, got, 2)
	require.Equal(t, "checkout", got[0].AppID)
	require.Equal(t, "inventory", got[1].AppID)
}

func TestAppsDetailReturnsInstance(t *testing.T) {
	h := appsRouter(newFakeApps())
	res, body := get(t, h, "/checkout")
	require.Equal(t, http.StatusOK, res.StatusCode)

	var got discovery.Instance
	require.NoError(t, json.Unmarshal([]byte(body), &got))
	require.Equal(t, "checkout", got.AppID)
	require.Equal(t, 3000, got.HTTPPort)
}

func TestAppsDetailReturns404ForUnknownApp(t *testing.T) {
	h := appsRouter(newFakeApps())
	res, _ := get(t, h, "/does-not-exist")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}
