//go:build unit

package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

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
	h := workflowsRouter(svc, nil, nil)
	res, body := get(t, h, "/?status=Running&search=ab")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"abc"`)
}

func TestWorkflowDetailAndNotFound(t *testing.T) {
	svc := fakeWF{one: workflow.Execution{ExecutionSummary: workflow.ExecutionSummary{AppID: "order", InstanceID: "abc", Status: workflow.StatusCompleted}}}
	h := workflowsRouter(svc, nil, nil)
	res, body := get(t, h, "/order/abc")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"status":"Completed"`)

	// fakeWF.Get returns ErrNotFound for id "missing"
	res, _ = get(t, h, "/order/missing")
	require.Equal(t, http.StatusNotFound, res.StatusCode)

	noStore := fakeWF{err: workflow.ErrNoStore}
	h2 := workflowsRouter(noStore, nil, nil)
	res, _ = get(t, h2, "/")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
}

func TestWorkflowDetailNoStore(t *testing.T) {
	noStore := fakeWF{err: workflow.ErrNoStore}
	h := workflowsRouter(noStore, nil, nil)
	res, _ := get(t, h, "/order/abc")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
}
