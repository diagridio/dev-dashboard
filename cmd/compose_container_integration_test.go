//go:build unit

package cmd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// fakeSidecar serves the daprd endpoints the dashboard probes in compose
// container posture: health, metadata, and publish.
func fakeSidecar(t *testing.T, published chan<- string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1.0/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/v1.0/metadata", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id": "order-processor",
			"runtimeVersion": "1.18.1",
			"actorRuntime": {"placement": "placement: connected"},
			"components": [{"name": "statestore", "type": "state.redis", "version": "v1"}],
			"subscriptions": [{"pubsubname": "pubsub", "topic": "orders", "rules": [], "type": "DECLARATIVE"}]
		}`))
	})
	mux.HandleFunc("/v1.0/publish/", func(w http.ResponseWriter, r *http.Request) {
		select {
		case published <- r.URL.Path:
		default:
		}
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestComposeContainerPostureDiscoversAppOverSidecarHTTP(t *testing.T) {
	published := make(chan string, 1)
	sidecar := fakeSidecar(t, &published)

	env := map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "1",
		"DEVDASHBOARD_APP_0_ID":        "order-processor",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": sidecar.URL,
		"DEVDASHBOARD_APP_0_LABEL":     "Order Processor",
	}
	scan, err := discovery.NewContractScanner(func(k string) string { return env[k] }, discovery.SourceCompose)
	if err != nil {
		t.Fatalf("contract scanner: %v", err)
	}

	svc := discovery.New(scan, &http.Client{Timeout: 2 * time.Second})
	apps, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(apps) != 1 {
		t.Fatalf("got %d apps want 1", len(apps))
	}
	app := apps[0]

	// Application data: the source frames it as compose, not aspire.
	if app.Source != discovery.SourceCompose {
		t.Errorf("source: got %q want %q", app.Source, discovery.SourceCompose)
	}
	if app.IsAspire {
		t.Error("IsAspire must be false for compose-source apps")
	}
	if app.Health != discovery.HealthHealthy {
		t.Errorf("health: got %q want %q", app.Health, discovery.HealthHealthy)
	}
	if !app.MetadataOK {
		t.Error("metadata probe failed")
	}
	if app.RuntimeVersion != "1.18.1" {
		t.Errorf("runtimeVersion: got %q want 1.18.1", app.RuntimeVersion)
	}
	if app.Label != "Order Processor" {
		t.Errorf("label: got %q want %q", app.Label, "Order Processor")
	}

	// Placement connectivity arrives free via sidecar metadata (the spec's
	// stated substitute for the disabled Control Plane page).
	if app.Placement == "" {
		t.Error("placement status must be populated from sidecar metadata")
	}

	// Component review without any mounted file: names and types only.
	if len(app.Components) != 1 || app.Components[0].Type != "state.redis" {
		t.Errorf("components: got %+v want one state.redis", app.Components)
	}
	if len(app.Subscriptions) != 1 || app.Subscriptions[0].Topic != "orders" {
		t.Errorf("subscriptions: got %+v want one orders topic", app.Subscriptions)
	}

	// The gRPC address is derived from the HTTP base URL's host.
	u, _ := url.Parse(sidecar.URL)
	if want := u.Hostname() + ":50001"; app.GRPCAddr() != want {
		t.Errorf("grpc addr: got %q want %q", app.GRPCAddr(), want)
	}

	// Publish reaches the sidecar.
	req, err := http.NewRequest(http.MethodPost, app.BaseURL()+"/v1.0/publish/pubsub/orders", strings.NewReader(`{"k":"v"}`))
	if err != nil {
		t.Fatalf("publish request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("publish status: got %d want %d", resp.StatusCode, http.StatusNoContent)
	}
	select {
	case got := <-published:
		if got != "/v1.0/publish/pubsub/orders" {
			t.Errorf("publish path: got %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Error("publish never reached the sidecar")
	}
}
