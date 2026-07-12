//go:build unit

package discovery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestFetchMetadataRichFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"id":"order","runtimeVersion":"1.18.0",
			"enabledFeatures":["ServiceInvocation","StateStore"],
			"actors":[{"type":"OrderActor","count":3}],
			"components":[{"name":"statestore","type":"state.redis","version":"v1"}],
			"subscriptions":[{"pubsubname":"pubsub","topic":"orders","deadLetterTopic":"orders-dlq","type":"PROGRAMMATIC","rules":[{"match":"","path":"/orders"}]}],
			"actorRuntime":{"runtimeStatus":"RUNNING","placement":"placement: connected","hostReady":true},
			"extended":{"appCommand":"go run ./cmd/order"}
		}`))
	}))
	t.Cleanup(srv.Close)

	md, err := FetchMetadata(context.Background(), &http.Client{Timeout: 2 * time.Second}, srv.URL)
	require.NoError(t, err)
	require.Equal(t, []string{"ServiceInvocation", "StateStore"}, md.EnabledFeatures)
	require.Len(t, md.Actors, 1)
	require.Equal(t, "OrderActor", md.Actors[0].Type)
	require.Equal(t, 3, md.Actors[0].Count)
	require.Len(t, md.Components, 1)
	require.Equal(t, "statestore", md.Components[0].Name)
	require.Equal(t, "state.redis", md.Components[0].Type)
	require.Len(t, md.Subscriptions, 1)
	require.Equal(t, "pubsub", md.Subscriptions[0].PubsubName)
	require.Equal(t, "orders", md.Subscriptions[0].Topic)
	require.Equal(t, "orders-dlq", md.Subscriptions[0].DeadLetterTopic)
	require.Equal(t, "/orders", md.Subscriptions[0].Rules[0].Path)
	require.Equal(t, "placement: connected", md.Placement)
}

func TestFetchMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"order","runtimeVersion":"1.14.4","extended":{"appPID":"48213","cliPID":"48201","appCommand":"go run ./cmd/order","appLogPath":"/l/app.log","daprdLogPath":"/l/daprd.log","runTemplateName":"dapr.yaml"}}`))
	}))
	t.Cleanup(srv.Close)

	md, err := FetchMetadata(context.Background(), &http.Client{Timeout: 2 * time.Second}, srv.URL)
	require.NoError(t, err)
	require.Equal(t, "order", md.ID)
	require.Equal(t, "1.14.4", md.RuntimeVersion)
	require.Equal(t, 48213, md.AppPID)
	require.Equal(t, "go run ./cmd/order", md.AppCommand)
	require.Equal(t, "dapr.yaml", md.RunTemplate)
}

func TestFetchMetadataRunTemplateFallsBackToPathBasename(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"order","extended":{"runTemplateName":"","runTemplatePath":"/home/dev/myapp/dapr.yaml"}}`))
	}))
	t.Cleanup(srv.Close)

	md, err := FetchMetadata(context.Background(), &http.Client{Timeout: 2 * time.Second}, srv.URL)
	require.NoError(t, err)
	require.Equal(t, "dapr.yaml", md.RunTemplate)
}

func TestFetchMetadataRunTemplateEmptyWhenNeitherFieldSet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"order","extended":{}}`))
	}))
	t.Cleanup(srv.Close)

	md, err := FetchMetadata(context.Background(), &http.Client{Timeout: 2 * time.Second}, srv.URL)
	require.NoError(t, err)
	require.Equal(t, "", md.RunTemplate)
}
