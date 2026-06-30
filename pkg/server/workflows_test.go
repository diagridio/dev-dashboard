//go:build unit

package server

import (
	"context"
	"fmt"
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
// If failIDs is non-empty, Resolve returns an error for those instance IDs.
type fakeResolver struct {
	failIDs map[string]bool
}

func (f fakeResolver) Resolve(_ context.Context, appID, instanceID string) (workflow.RemoveTarget, error) {
	if f.failIDs[instanceID] {
		return workflow.RemoveTarget{}, fmt.Errorf("resolve error for %s", instanceID)
	}
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
	list   workflow.ListResult
	stats  workflow.StatsResult
	one    workflow.Execution
	appIDs []string
	err    error
}

func (f fakeWF) List(context.Context, workflow.ListQuery) (workflow.ListResult, error) {
	return f.list, f.err
}
func (f fakeWF) Stats(context.Context, workflow.ListQuery) (workflow.StatsResult, error) {
	return f.stats, f.err
}
func (f fakeWF) AppIDs(context.Context) ([]string, error) {
	return f.appIDs, f.err
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

func TestWorkflowAppIDs(t *testing.T) {
	svc := fakeWF{appIDs: []string{"order", "pr-digest"}}
	h := workflowsRouter(newFakeBackend(svc), nil)
	res, body := get(t, h, "/appids")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.JSONEq(t, `["order","pr-digest"]`, body)
}

func TestWorkflowAppIDsNoStore(t *testing.T) {
	noStore := fakeWF{err: workflow.ErrNoStore}
	h := workflowsRouter(newFakeBackend(noStore), nil)
	res, _ := get(t, h, "/appids")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
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

func TestWorkflowBulkPurge(t *testing.T) {
	rem := &fakeRemover{}
	backend := &fakeBackend{svc: fakeWF{}, rem: rem, targets: fakeResolver{}}
	h := workflowsRouter(backend, nil)
	res, body := postJSON(t, h, "/purge", `{"ids":[{"appId":"order","instanceId":"a"},{"appId":"order","instanceId":"b"}],"force":true}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"a"`)
	require.Len(t, rem.calls, 2)
}

func TestWorkflowBulkPurgeReconcilesFailed(t *testing.T) {
	rem := &fakeRemover{}
	resolver := fakeResolver{failIDs: map[string]bool{"bad": true}}
	backend := &fakeBackend{svc: fakeWF{}, rem: rem, targets: resolver}
	h := workflowsRouter(backend, nil)
	res, body := postJSON(t, h, "/purge", `{"ids":[{"appId":"order","instanceId":"good"},{"appId":"order","instanceId":"bad"}]}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	// Both results must be present.
	require.Contains(t, body, `"instanceId":"good"`)
	require.Contains(t, body, `"instanceId":"bad"`)
	// "good" resolved → remover called once and returned ok:true.
	require.Len(t, rem.calls, 1)
	require.Equal(t, "good", rem.calls[0].InstanceID)
	// "bad" failed to resolve → ok:false in response.
	require.Contains(t, body, `"ok":false`)
	require.Contains(t, body, `"error":"could not resolve target"`)
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

	// POST bulk purge with unknown store → 404
	res, body = postJSON(t, h, "/purge?store=unknown", `{}`)
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

func TestWorkflowsStats(t *testing.T) {
	svc := fakeWF{stats: workflow.StatsResult{
		Counts: map[workflow.Status]int{workflow.StatusRunning: 2, workflow.StatusCompleted: 1},
		Total:  3,
	}}
	h := workflowsRouter(newFakeBackend(svc), nil)
	res, body := get(t, h, "/stats?appId=order")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"total":3`)
	require.Contains(t, body, `"Running":2`)
	require.Contains(t, body, `"Completed":1`)
}

func TestWorkflowsStatsUnknownStore(t *testing.T) {
	h := workflowsRouter(newFakeBackend(fakeWF{}), nil)
	res, _ := get(t, h, "/stats?store=unknown")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestStateStoresEndpoint(t *testing.T) {
	stores := fakeStoreRegistry{stores: []StoreInfo{
		{ID: "statestore-auto", Name: "statestore", Type: "state.redis", Source: "auto", Active: true, Connection: "localhost:6379"},
	}}
	h := apiRouter(version.Info{}, nil, newFakeBackend(fakeWF{}), stores, fakeResources{}, fakeNews{})
	res, body := get(t, h, "/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"name":"statestore"`)
	require.Contains(t, body, `"connection":"localhost:6379"`)
	// Lock the contract the frontend depends on: id and source must be serialised.
	require.Contains(t, body, `"id":"statestore-auto"`)
	require.Contains(t, body, `"source":"auto"`)
}

func TestStateStoresNilRegistry(t *testing.T) {
	h := apiRouter(version.Info{}, nil, newFakeBackend(fakeWF{}), nil, fakeResources{}, fakeNews{})
	res, body := get(t, h, "/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `[]`)
}

// fakeStoreRegistry implements StoreRegistry for tests.
type fakeStoreRegistry struct {
	stores []StoreInfo
}

func (f fakeStoreRegistry) Stores() []StoreInfo                              { return f.stores }
func (f fakeStoreRegistry) AddStore(string, string, map[string]string) error { return nil }
func (f fakeStoreRegistry) UpdateStore(string, string, string, map[string]string) (string, error) {
	return "", nil
}
func (f fakeStoreRegistry) DeleteStore(string) error { return nil }

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

func TestWorkflowsListUnreachableStore(t *testing.T) {
	unreachable := workflow.NewUnreachableService("statestore", "localhost:16379")
	h := workflowsRouter(newFakeBackend(unreachable), nil)

	res, body := get(t, h, "/")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
	require.Contains(t, body, "could not connect to state store")
	require.Contains(t, body, "statestore")
	require.Contains(t, body, "localhost:16379")
	// Must NOT be the generic no-store message.
	require.NotContains(t, body, "no state store detected")
}

func TestParseListQueryIncludeChildren(t *testing.T) {
	// Absent param ⇒ children shown (default true).
	req := httptest.NewRequest(http.MethodGet, "/workflows", nil)
	require.True(t, parseListQuery(req).IncludeChildren)

	// Explicit false ⇒ children hidden.
	req = httptest.NewRequest(http.MethodGet, "/workflows?includeChildren=false", nil)
	require.False(t, parseListQuery(req).IncludeChildren)

	// Explicit true ⇒ children shown.
	req = httptest.NewRequest(http.MethodGet, "/workflows?includeChildren=true", nil)
	require.True(t, parseListQuery(req).IncludeChildren)
}

func TestWorkflowsStatsUnreachableStore(t *testing.T) {
	unreachable := workflow.NewUnreachableService("statestore", "localhost:16379")
	h := workflowsRouter(newFakeBackend(unreachable), nil)

	res, body := get(t, h, "/stats")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
	require.Contains(t, body, "could not connect to state store")
}

func TestWorkflowDetailUnreachableStore(t *testing.T) {
	unreachable := workflow.NewUnreachableService("statestore", "localhost:16379")
	h := workflowsRouter(newFakeBackend(unreachable), nil)

	res, body := get(t, h, "/order/abc")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
	require.Contains(t, body, "could not connect to state store")
	require.NotContains(t, body, "no state store detected")
}

func TestWorkflowsNoStoreMessageUnchanged(t *testing.T) {
	noStore := fakeWF{err: workflow.ErrNoStore}
	h := workflowsRouter(newFakeBackend(noStore), nil)

	res, body := get(t, h, "/")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
	require.Contains(t, body, "no state store detected")
}
