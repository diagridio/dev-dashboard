//go:build unit

package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

// fakeRemover records calls to RemoveMany and returns OK results.
type fakeRemover struct {
	calls []workflow.RemoveTarget
}

func (f *fakeRemover) RemoveMany(_ context.Context, targets []workflow.RemoveTarget, _ bool) []workflow.RemoveResult {
	f.calls = append(f.calls, targets...)
	out := make([]workflow.RemoveResult, len(targets))
	for i, t := range targets {
		out[i] = workflow.RemoveResult{InstanceID: t.InstanceID, OK: true}
	}
	return out
}

// fakeResolver always returns a fixed RemoveTarget.
type fakeResolver struct{}

func (fakeResolver) Resolve(_ context.Context, appID, instanceID string) (workflow.RemoveTarget, error) {
	return workflow.RemoveTarget{
		AppID:      appID,
		InstanceID: instanceID,
		Status:     workflow.StatusCompleted,
		HTTPPort:   3500,
		Healthy:    true,
	}, nil
}

// postJSON is a test helper mirroring get() but for POST requests with a JSON body.
func postJSON(t *testing.T, h http.Handler, path, body string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

type fakeWF struct {
	list workflow.ListResult
	one  workflow.Execution
	err  error
}

func (f fakeWF) List(context.Context, workflow.ListQuery) (workflow.ListResult, error) {
	return f.list, f.err
}
func (f fakeWF) Get(_ context.Context, appID, id string) (workflow.Execution, error) {
	if f.err != nil {
		return workflow.Execution{}, f.err
	}
	if id == "missing" {
		return workflow.Execution{}, workflow.ErrNotFound
	}
	return f.one, nil
}

func TestWorkflowsList(t *testing.T) {
	svc := fakeWF{list: workflow.ListResult{Items: []workflow.ExecutionSummary{{AppID: "order", InstanceID: "abc", Status: workflow.StatusRunning}}}}
	h := workflowsRouter(newFakeBackend(svc), nil)
	res, body := get(t, h, "/?status=Running&search=ab")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"abc"`)
}

func TestWorkflowDetailAndNotFound(t *testing.T) {
	svc := fakeWF{one: workflow.Execution{ExecutionSummary: workflow.ExecutionSummary{AppID: "order", InstanceID: "abc", Status: workflow.StatusCompleted}}}
	h := workflowsRouter(newFakeBackend(svc), nil)
	res, body := get(t, h, "/order/abc")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"status":"Completed"`)

	// fakeWF.Get returns ErrNotFound for id "missing"
	res, _ = get(t, h, "/order/missing")
	require.Equal(t, http.StatusNotFound, res.StatusCode)

	noStore := fakeWF{err: workflow.ErrNoStore}
	h2 := workflowsRouter(newFakeBackend(noStore), nil)
	res, _ = get(t, h2, "/")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
}

func TestWorkflowDetailNoStore(t *testing.T) {
	noStore := fakeWF{err: workflow.ErrNoStore}
	h := workflowsRouter(newFakeBackend(noStore), nil)
	res, _ := get(t, h, "/order/abc")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
}

func TestWorkflowPurgeSingle(t *testing.T) {
	rem := &fakeRemover{}
	backend := &fakeBackend{svc: fakeWF{}, rem: rem, targets: fakeResolver{}}
	h := workflowsRouter(backend, nil)
	res, body := postJSON(t, h, "/order/abc/purge", `{"force":false}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"ok":true`)
	require.Len(t, rem.calls, 1)
	require.Equal(t, "abc", rem.calls[0].InstanceID)
}

func TestWorkflowTerminateSingle(t *testing.T) {
	rem := &fakeRemover{}
	backend := &fakeBackend{svc: fakeWF{}, rem: rem, targets: fakeResolver{}}
	h := workflowsRouter(backend, nil)
	res, body := postJSON(t, h, "/order/abc/terminate", `{}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"ok":true`)
	require.Len(t, rem.calls, 1)
	require.Equal(t, "abc", rem.calls[0].InstanceID)
}

func TestWorkflowBulkPurge(t *testing.T) {
	rem := &fakeRemover{}
	backend := &fakeBackend{svc: fakeWF{}, rem: rem, targets: fakeResolver{}}
	h := workflowsRouter(backend, nil)
	res, body := postJSON(t, h, "/purge", `{"ids":[{"appId":"order","instanceId":"a"},{"appId":"order","instanceId":"b"}],"force":true}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"a"`)
	require.Len(t, rem.calls, 2)
}

func TestWorkflowUnknownStore(t *testing.T) {
	h := workflowsRouter(newFakeBackend(fakeWF{}), nil)

	// GET list with unknown store → 404
	res, body := get(t, h, "/?store=unknown")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.Contains(t, body, "unknown state store")

	// GET detail with unknown store → 404
	res, body = get(t, h, "/order/abc?store=unknown")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.Contains(t, body, "unknown state store")

	// POST purge with unknown store → 404
	res, body = postJSON(t, h, "/purge?store=unknown", `{}`)
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.Contains(t, body, "unknown state store")

	res, body = postJSON(t, h, "/order/abc/terminate?store=unknown", `{}`)
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.Contains(t, body, "unknown state store")

	res, body = postJSON(t, h, "/order/abc/purge?store=unknown", `{}`)
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.Contains(t, body, "unknown state store")
}

func TestWorkflowActiveStore(t *testing.T) {
	svc := fakeWF{list: workflow.ListResult{Items: []workflow.ExecutionSummary{{AppID: "app1", InstanceID: "i1", Status: workflow.StatusRunning}}}}
	h := workflowsRouter(newFakeBackend(svc), nil)

	// GET list with empty store= (active) → 200
	res, body := get(t, h, "/?store=")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"i1"`)
}

func TestStateStoresEndpoint(t *testing.T) {
	stores := fakeStoreRegistry{stores: []StoreInfo{
		{Name: "statestore", Type: "state.redis", Active: true},
	}}
	h := apiRouter(version.Info{}, nil, newFakeBackend(fakeWF{}), stores, fakeResources{})
	res, body := get(t, h, "/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"name":"statestore"`)
}

func TestStateStoresNilRegistry(t *testing.T) {
	h := apiRouter(version.Info{}, nil, newFakeBackend(fakeWF{}), nil, fakeResources{})
	res, body := get(t, h, "/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `[]`)
}

// fakeStoreRegistry implements StoreRegistry for tests.
type fakeStoreRegistry struct {
	stores []StoreInfo
}

func (f fakeStoreRegistry) Stores() []StoreInfo { return f.stores }

// fakeBackend implements WorkflowBackend for tests.
// It returns a fixed svc/rem/resolver for any store name except "unknown".
type fakeBackend struct {
	svc     workflow.Service
	rem     WorkflowRemover
	targets TargetResolver
}

func newFakeBackend(svc workflow.Service) *fakeBackend {
	return &fakeBackend{svc: svc, rem: &fakeRemover{}, targets: fakeResolver{}}
}

func (f *fakeBackend) ServiceFor(store string) (workflow.Service, WorkflowRemover, TargetResolver, bool) {
	if store == "unknown" {
		return nil, nil, nil, false
	}
	return f.svc, f.rem, f.targets, true
}
