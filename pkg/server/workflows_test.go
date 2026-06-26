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
	h := workflowsRouter(svc, nil, nil, nil)
	res, body := get(t, h, "/?status=Running&search=ab")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"abc"`)
}

func TestWorkflowDetailAndNotFound(t *testing.T) {
	svc := fakeWF{one: workflow.Execution{ExecutionSummary: workflow.ExecutionSummary{AppID: "order", InstanceID: "abc", Status: workflow.StatusCompleted}}}
	h := workflowsRouter(svc, nil, nil, nil)
	res, body := get(t, h, "/order/abc")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"status":"Completed"`)

	// fakeWF.Get returns ErrNotFound for id "missing"
	res, _ = get(t, h, "/order/missing")
	require.Equal(t, http.StatusNotFound, res.StatusCode)

	noStore := fakeWF{err: workflow.ErrNoStore}
	h2 := workflowsRouter(noStore, nil, nil, nil)
	res, _ = get(t, h2, "/")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
}

func TestWorkflowDetailNoStore(t *testing.T) {
	noStore := fakeWF{err: workflow.ErrNoStore}
	h := workflowsRouter(noStore, nil, nil, nil)
	res, _ := get(t, h, "/order/abc")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
}

func TestWorkflowPurgeSingle(t *testing.T) {
	rem := &fakeRemover{}
	resolver := fakeResolver{}
	h := workflowsRouter(fakeWF{}, rem, nil, resolver)
	res, body := postJSON(t, h, "/order/abc/purge", `{"force":false}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"ok":true`)
	require.Len(t, rem.calls, 1)
	require.Equal(t, "abc", rem.calls[0].InstanceID)
}

func TestWorkflowTerminateSingle(t *testing.T) {
	rem := &fakeRemover{}
	h := workflowsRouter(fakeWF{}, rem, nil, fakeResolver{})
	res, body := postJSON(t, h, "/order/abc/terminate", `{}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"ok":true`)
	require.Len(t, rem.calls, 1)
	require.Equal(t, "abc", rem.calls[0].InstanceID)
}

func TestWorkflowBulkPurge(t *testing.T) {
	rem := &fakeRemover{}
	h := workflowsRouter(fakeWF{}, rem, nil, fakeResolver{})
	res, body := postJSON(t, h, "/purge", `{"ids":[{"appId":"order","instanceId":"a"},{"appId":"order","instanceId":"b"}],"force":true}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"a"`)
	require.Len(t, rem.calls, 2)
}

func TestStateStoresEndpoint(t *testing.T) {
	stores := fakeStoreRegistry{stores: []StoreInfo{
		{Name: "statestore", Type: "state.redis", Active: true},
	}}
	h := apiRouter(version.Info{}, nil, fakeWF{}, nil, stores, nil)
	res, body := get(t, h, "/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"name":"statestore"`)
}

func TestStateStoresNilRegistry(t *testing.T) {
	h := apiRouter(version.Info{}, nil, fakeWF{}, nil, nil, nil)
	res, body := get(t, h, "/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `[]`)
}

// fakeStoreRegistry implements StoreRegistry for tests.
type fakeStoreRegistry struct {
	stores []StoreInfo
}

func (f fakeStoreRegistry) Stores() []StoreInfo { return f.stores }
