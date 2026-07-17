//go:build unit

package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/lifecycle"
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
	h := appsRouter(newFakeApps(), nil, nil, FullCapabilities())
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
	h := appsRouter(newFakeApps(), nil, nil, FullCapabilities())
	res, body := get(t, h, "/checkout")
	require.Equal(t, http.StatusOK, res.StatusCode)

	var got discovery.Instance
	require.NoError(t, json.Unmarshal([]byte(body), &got))
	require.Equal(t, "checkout", got.AppID)
	require.Equal(t, 3000, got.HTTPPort)
}

func TestAppsDetailReturns404ForUnknownApp(t *testing.T) {
	h := appsRouter(newFakeApps(), nil, nil, FullCapabilities())
	res, _ := get(t, h, "/does-not-exist")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestAppsLogsReturns404WhenNoLogPath(t *testing.T) {
	h := appsRouter(&fakeApps{instances: []discovery.Instance{{AppID: "order"}}}, nil, nil, FullCapabilities())
	res, _ := get(t, h, "/order/logs")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

// fakeLifecycle is a test double for lifecycle.Manager.
type fakeLifecycle struct {
	err       error
	forgetErr error
	gotKey    string
	gotTgt    lifecycle.Target
	gotAct    lifecycle.Action
}

func (f *fakeLifecycle) Do(ctx context.Context, key string, target lifecycle.Target, action lifecycle.Action) error {
	f.gotKey, f.gotTgt, f.gotAct = key, target, action
	return f.err
}

func (f *fakeLifecycle) Forget(ctx context.Context, key string) error {
	f.gotKey = key
	return f.forgetErr
}

func TestAppsLifecycleRoute(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
	}{
		{"ok", nil, http.StatusOK},
		{"invalid target", lifecycle.ErrInvalidTarget, http.StatusBadRequest},
		{"invalid action", lifecycle.ErrInvalidAction, http.StatusBadRequest},
		{"unsupported", lifecycle.ErrUnsupported, http.StatusBadRequest},
		{"not found", discovery.ErrNotFound, http.StatusNotFound},
		{"runtime unavailable", lifecycle.ErrRuntimeUnavailable, http.StatusServiceUnavailable},
		{"exec failure", errors.New("boom"), http.StatusBadGateway},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			life := &fakeLifecycle{err: tc.err}
			h := appsRouter(newFakeApps(), nil, life, FullCapabilities())
			req := httptest.NewRequest(http.MethodPost, "/orders/app/stop", nil)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			require.Equal(t, tc.status, rec.Code)
			if tc.err == nil {
				require.Equal(t, "orders", life.gotKey)
				require.Equal(t, lifecycle.TargetApp, life.gotTgt)
				require.Equal(t, lifecycle.ActionStop, life.gotAct)
			}
		})
	}
}

func TestAppsLifecycleRouteNilManager(t *testing.T) {
	h := appsRouter(newFakeApps(), nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/orders/app/stop", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

func TestAppsForgetRoute(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
	}{
		{"ok", nil, http.StatusNoContent},
		{"not found", discovery.ErrNotFound, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			life := &fakeLifecycle{forgetErr: tc.err}
			h := appsRouter(newFakeApps(), nil, life, FullCapabilities())
			req := httptest.NewRequest(http.MethodDelete, "/orders", nil)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			require.Equal(t, tc.status, rec.Code)
			if tc.err == nil {
				require.Equal(t, "orders", life.gotKey)
			}
		})
	}
}

func TestAppsForgetRouteNilManager(t *testing.T) {
	h := appsRouter(newFakeApps(), nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodDelete, "/orders", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
}

func TestPublishProxiesToSidecar(t *testing.T) {
	var gotPath, gotCT, gotBody, gotQuery string
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotCT = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer sidecar.Close()

	apps := &fakeApps{instances: []discovery.Instance{{
		AppID:            "order",
		SidecarReachable: true,
		DaprHTTPBaseURL:  sidecar.URL,
		Components:       []discovery.Component{{Name: "pubsub", Type: "pubsub.redis"}},
	}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())

	body := `{"pubsubName":"pubsub","topic":"orders","data":"{\"id\":1}","contentType":"application/json","metadata":{"ttlInSeconds":"60"}}`
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(body))
	res, respBody := doReq(t, h, req)

	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, respBody, `"status":"published"`)
	require.Equal(t, "/v1.0/publish/pubsub/orders", gotPath)
	require.Equal(t, "application/json", gotCT)
	require.Equal(t, `{"id":1}`, gotBody)
	require.Equal(t, "metadata.ttlInSeconds=60", gotQuery)
}

func TestPublishRejectsUnknownPubsub(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{{
		AppID: "order", SidecarReachable: true,
		Components: []discovery.Component{{Name: "pubsub", Type: "pubsub.redis"}},
	}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(`{"pubsubName":"nope","topic":"orders"}`))
	res, body := doReq(t, h, req)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
	require.Contains(t, body, "unknown pub/sub component")
}

func TestPublishRejectsEmptyTopic(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{{
		AppID: "order", SidecarReachable: true,
		Components: []discovery.Component{{Name: "pubsub", Type: "pubsub.redis"}},
	}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(`{"pubsubName":"pubsub","topic":""}`))
	res, _ := doReq(t, h, req)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestPublishUnreachableSidecar(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{{AppID: "order", SidecarReachable: false}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(`{"pubsubName":"pubsub","topic":"orders"}`))
	res, _ := doReq(t, h, req)
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
}

func TestPublishUnknownApp(t *testing.T) {
	h := appsRouter(&fakeApps{}, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/ghost/publish", strings.NewReader(`{"pubsubName":"pubsub","topic":"orders"}`))
	res, body := doReq(t, h, req)
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.Contains(t, body, "app not found")
}

func TestPublishPassesThroughDaprdError(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"errorCode":"ERR","message":"denied"}`))
	}))
	defer sidecar.Close()
	apps := &fakeApps{instances: []discovery.Instance{{
		AppID: "order", SidecarReachable: true, DaprHTTPBaseURL: sidecar.URL,
		Components: []discovery.Component{{Name: "pubsub", Type: "pubsub.redis"}},
	}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(`{"pubsubName":"pubsub","topic":"orders"}`))
	res, body := doReq(t, h, req)
	require.Equal(t, http.StatusForbidden, res.StatusCode)

	var got map[string]string
	require.NoError(t, json.Unmarshal([]byte(body), &got))
	require.Equal(t, "denied", got["error"])
}

func TestPublishNetworkFailure(t *testing.T) {
	// A closed server's address will refuse connections, simulating a
	// dial/network failure distinct from a daprd-returned error status.
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	unreachableURL := sidecar.URL
	sidecar.Close()

	apps := &fakeApps{instances: []discovery.Instance{{
		AppID: "order", SidecarReachable: true, DaprHTTPBaseURL: unreachableURL,
		Components: []discovery.Component{{Name: "pubsub", Type: "pubsub.redis"}},
	}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(`{"pubsubName":"pubsub","topic":"orders"}`))
	res, _ := doReq(t, h, req)
	require.Equal(t, http.StatusBadGateway, res.StatusCode)
}
