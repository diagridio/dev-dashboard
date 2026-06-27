//go:build unit

package server

import (
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func TestActorsAggregate(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "order", Placement: "connected", Actors: []discovery.ActorType{{Type: "OrderActor", Count: 2}}},
		{AppID: "cart", Actors: []discovery.ActorType{{Type: "CartActor", Count: 1}}},
	}}
	h := actorsRouter(apps)
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"appId":"order"`)
	require.Contains(t, body, `"type":"OrderActor"`)
	require.Contains(t, body, `"type":"CartActor"`)

	res, body = get(t, h, "/?appId=order")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"OrderActor"`)
	require.NotContains(t, body, `"CartActor"`)
}
