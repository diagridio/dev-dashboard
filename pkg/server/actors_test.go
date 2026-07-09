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
	require.Contains(t, body, `"appId":"cart"`)

	res, body = get(t, h, "/?appId=order")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"type":"OrderActor"`)
	require.NotContains(t, body, `"type":"CartActor"`)
}

func TestActorsRowsCarryInstanceKey(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-1", Actors: []discovery.ActorType{{Type: "QueueActor", Count: 1}}},
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-2", Actors: []discovery.ActorType{{Type: "QueueActor", Count: 2}}},
		// Fixture without InstanceKey (pre-existing shape) falls back to app id.
		{AppID: "cart", Actors: []discovery.ActorType{{Type: "CartActor", Count: 1}}},
	}}
	h := actorsRouter(apps)
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceKey":"daprmq-host-1"`)
	require.Contains(t, body, `"instanceKey":"daprmq-host-2"`)
	require.Contains(t, body, `"instanceKey":"cart"`)
}
