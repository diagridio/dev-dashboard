//go:build unit

package server

import (
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func TestSubscriptionsAggregate(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "order", Subscriptions: []discovery.Subscription{{PubsubName: "pubsub", Topic: "orders", DeadLetterTopic: "orders-dlq", Rules: []discovery.SubRule{{Path: "/orders"}}}}},
		{AppID: "cart", Subscriptions: []discovery.Subscription{{PubsubName: "pubsub", Topic: "carts"}}},
	}}
	h := subscriptionsRouter(apps)
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"topic":"orders"`)
	require.Contains(t, body, `"deadLetterTopic":"orders-dlq"`)
	require.Contains(t, body, `"topic":"carts"`)

	res, body = get(t, h, "/?appId=cart")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"carts"`)
	require.NotContains(t, body, `"orders"`)
}

func TestSubscriptionsRowsCarryInstanceKey(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-1", Subscriptions: []discovery.Subscription{{PubsubName: "kafka-pubsub", Topic: "orders"}}},
		{AppID: "cart", Subscriptions: []discovery.Subscription{{PubsubName: "pubsub", Topic: "carts"}}},
	}}
	h := subscriptionsRouter(apps)
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceKey":"daprmq-host-1"`)
	require.Contains(t, body, `"instanceKey":"cart"`)
}
