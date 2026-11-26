//go:build unit

package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/actors"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

type fakeActors struct {
	rows      []actors.TypeRow
	detail    actors.TypeDetail
	actor     actors.ActorDetail
	invokeRes actors.InvokeResult
	err       error

	gotAppID string
	gotArgs  []string
	gotReq   actors.InvokeRequest
}

func (f *fakeActors) List(_ context.Context, appID string) ([]actors.TypeRow, error) {
	f.gotAppID = appID
	return f.rows, f.err
}
func (f *fakeActors) Type(_ context.Context, key, typ string) (actors.TypeDetail, error) {
	f.gotArgs = []string{key, typ}
	return f.detail, f.err
}
func (f *fakeActors) Actor(_ context.Context, key, typ, id string) (actors.ActorDetail, error) {
	f.gotArgs = []string{key, typ, id}
	return f.actor, f.err
}
func (f *fakeActors) Invoke(_ context.Context, key, typ, id string, r actors.InvokeRequest) (actors.InvokeResult, error) {
	f.gotArgs = []string{key, typ, id}
	f.gotReq = r
	return f.invokeRes, f.err
}
func (f *fakeActors) DeleteReminder(_ context.Context, key, typ, id, name string) error {
	f.gotArgs = []string{key, typ, id, name}
	return f.err
}

func TestActorsListRoute(t *testing.T) {
	two := 2
	f := &fakeActors{rows: []actors.TypeRow{{AppID: "order", InstanceKey: "order", Type: "OrderActor", Count: 2, Placement: "placement: connected", Reminders: &two}}}
	h := actorsRouter(f)
	res, body := get(t, h, "/?appId=order")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "order", f.gotAppID)
	for _, want := range []string{`"appId":"order"`, `"instanceKey":"order"`, `"type":"OrderActor"`, `"count":2`, `"placement":"placement: connected"`, `"reminders":2`} {
		require.Contains(t, body, want)
	}
}

func TestActorsListRouteEmptyIsArray(t *testing.T) {
	res, body := get(t, actorsRouter(&fakeActors{}), "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "[]", strings.TrimSpace(body))

	res, body = get(t, actorsRouter(nil), "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "[]", strings.TrimSpace(body))
}

func TestActorTypeRoute(t *testing.T) {
	f := &fakeActors{detail: actors.TypeDetail{TypeRow: actors.TypeRow{Type: "Deck"}, IDs: []actors.ActorID{{ID: "d1"}}, Truncated: true}}
	res, body := get(t, actorsRouter(f), "/orders-1/Deck")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, []string{"orders-1", "Deck"}, f.gotArgs)
	require.Contains(t, body, `"ids":[{"id":"d1"`)
	require.Contains(t, body, `"truncated":true`)

	f.err = fmt.Errorf("%w: x", discovery.ErrNotFound)
	res, _ = get(t, actorsRouter(f), "/x/Deck")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestActorDetailRouteDecodesParams(t *testing.T) {
	f := &fakeActors{actor: actors.ActorDetail{Type: "Deck", ID: "a/b"}}
	res, body := get(t, actorsRouter(f), "/orders-1/Deck/a%2Fb")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, []string{"orders-1", "Deck", "a/b"}, f.gotArgs)
	require.Contains(t, body, `"id":"a/b"`)
}

func TestInvokeRoute(t *testing.T) {
	f := &fakeActors{invokeRes: actors.InvokeResult{Status: 200, Body: `{"ok":true}`, DurationMs: 3}}
	h := actorsRouter(f)
	res, body := postJSON(t, h, "/orders-1/Deck/d1/invoke", `{"method":"Reset","verb":"POST","body":"{}"}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, []string{"orders-1", "Deck", "d1"}, f.gotArgs)
	require.Equal(t, actors.InvokeRequest{Method: "Reset", Verb: "POST", Body: "{}"}, f.gotReq)
	require.Contains(t, body, `"status":200`)
	require.Contains(t, body, `"durationMs":3`)

	cases := []struct {
		err  error
		want int
	}{
		{actors.ErrInternalType, http.StatusBadRequest},
		{fmt.Errorf("%w: method is required", actors.ErrInvalidRequest), http.StatusBadRequest},
		{fmt.Errorf("%w: x", discovery.ErrNotFound), http.StatusNotFound},
		{actors.ErrSidecarUnreachable, http.StatusServiceUnavailable},
		{errors.New("dial tcp: refused"), http.StatusBadGateway},
	}
	for _, c := range cases {
		f.err = c.err
		res, body = postJSON(t, h, "/orders-1/Deck/d1/invoke", `{"method":"Reset"}`)
		require.Equal(t, c.want, res.StatusCode, c.err.Error())
		require.Contains(t, body, `"error"`)
	}

	f.err = nil
	res, _ = postJSON(t, h, "/orders-1/Deck/d1/invoke", `not json`)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestDeleteReminderRoute(t *testing.T) {
	f := &fakeActors{}
	h := actorsRouter(f)
	del := func(path string) (*http.Response, string) {
		return doReq(t, h, httptest.NewRequest(http.MethodDelete, path, nil))
	}
	res, _ := del("/orders-1/Deck/d1/reminders/my%20rem")
	require.Equal(t, http.StatusNoContent, res.StatusCode)
	require.Equal(t, []string{"orders-1", "Deck", "d1", "my rem"}, f.gotArgs)

	f.err = actors.ErrInternalType
	res, _ = del("/orders-1/dapr.internal.x/d1/reminders/r")
	require.Equal(t, http.StatusBadRequest, res.StatusCode)

	f.err = errors.New("reminder not found")
	res, body := del("/orders-1/Deck/d1/reminders/r")
	require.Equal(t, http.StatusBadGateway, res.StatusCode)
	require.Contains(t, body, `"error":"reminder not found"`)
}
