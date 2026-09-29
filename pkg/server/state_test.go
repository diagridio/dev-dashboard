//go:build unit

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/state"
	"github.com/stretchr/testify/require"
)

// stubStateService records the last query and returns canned results.
type stubStateService struct {
	lastQuery   state.ListQuery
	lastKey     string
	lastDeletes []string
	list        state.ListResult
	listErr     error
	record      state.Record
	recordErr   error
	appIDs      []string
	appIDsErr   error
	deletes     []state.DeleteResult
	lastSet     state.SetRequest
	setErr      error

	lastAppIDsInternal bool
}

func (s *stubStateService) List(_ context.Context, q state.ListQuery) (state.ListResult, error) {
	s.lastQuery = q
	return s.list, s.listErr
}
func (s *stubStateService) Record(_ context.Context, key string) (state.Record, error) {
	s.lastKey = key
	return s.record, s.recordErr
}
func (s *stubStateService) AppIDs(_ context.Context, includeInternal bool) ([]string, error) {
	s.lastAppIDsInternal = includeInternal
	return s.appIDs, s.appIDsErr
}
func (s *stubStateService) Delete(_ context.Context, keys []string) []state.DeleteResult {
	s.lastDeletes = keys
	return s.deletes
}
func (s *stubStateService) Set(_ context.Context, req state.SetRequest) error {
	s.lastSet = req
	return s.setErr
}

// stubStateBackend serves one service, or reports the store unknown.
type stubStateBackend struct {
	svc     state.Service
	unknown bool
}

func (b stubStateBackend) StateFor(string) (state.Service, bool) {
	if b.unknown {
		return nil, false
	}
	return b.svc, true
}

func doState(t *testing.T, backend StateBackend, method, target string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	w := httptest.NewRecorder()
	stateRouter(backend).ServeHTTP(w, r)
	return w
}

func TestStateListQueryParsing(t *testing.T) {
	svc := &stubStateService{}
	b := stubStateBackend{svc: svc}

	doState(t, b, http.MethodGet, "/?appId=myapp&search=order&page=tok&limit=25&includeInternal=true", "")
	require.Equal(t, "myapp", svc.lastQuery.AppID)
	require.Equal(t, "order", svc.lastQuery.Search)
	require.Equal(t, "tok", svc.lastQuery.PageToken)
	require.Equal(t, 25, svc.lastQuery.PageSize)
	require.True(t, svc.lastQuery.IncludeInternal)

	t.Run("internal keys are excluded by default", func(t *testing.T) {
		doState(t, b, http.MethodGet, "/", "")
		require.False(t, svc.lastQuery.IncludeInternal)
	})
	t.Run("limit is capped", func(t *testing.T) {
		doState(t, b, http.MethodGet, "/?limit=100000", "")
		require.Equal(t, maxListPageSize, svc.lastQuery.PageSize)
	})
	t.Run("non-positive and unparseable limits fall back to the service default", func(t *testing.T) {
		for _, l := range []string{"0", "-5", "abc"} {
			doState(t, b, http.MethodGet, "/?limit="+l, "")
			require.Equal(t, 0, svc.lastQuery.PageSize, "limit=%s", l)
		}
	})
}

func TestStateListResponse(t *testing.T) {
	svc := &stubStateService{list: state.ListResult{
		Items:     []state.Item{{Key: "myapp||order-1", LogicalKey: "order-1", Kind: state.KindApp, Preview: "v", Size: 1}},
		NextToken: "next",
	}}
	w := doState(t, stubStateBackend{svc: svc}, http.MethodGet, "/", "")
	require.Equal(t, http.StatusOK, w.Code)
	var got state.ListResult
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Len(t, got.Items, 1)
	require.Equal(t, "myapp||order-1", got.Items[0].Key)
	require.Equal(t, "next", got.NextToken)
}

func TestStateUnknownStoreIs404(t *testing.T) {
	for _, target := range []string{"/", "/record?key=k", "/appids"} {
		w := doState(t, stubStateBackend{unknown: true}, http.MethodGet, target, "")
		require.Equal(t, http.StatusNotFound, w.Code, target)
		require.Contains(t, w.Body.String(), "unknown state store")
	}
	w := doState(t, stubStateBackend{unknown: true}, http.MethodPost, "/delete", `{"keys":["k"]}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestStateErrorMapping(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"no store", state.ErrNoStore, http.StatusServiceUnavailable, "no state store detected"},
		{"unreachable", state.ErrStoreUnreachable, http.StatusServiceUnavailable, "could not connect"},
		{"not browsable", state.ErrNotBrowsable, http.StatusServiceUnavailable, "cannot be browsed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := &stubStateService{listErr: tc.err}
			w := doState(t, stubStateBackend{svc: svc}, http.MethodGet, "/", "")
			require.Equal(t, tc.status, w.Code)
			require.Contains(t, w.Body.String(), tc.body)
		})
	}
}

func TestStateRecordEndpoint(t *testing.T) {
	svc := &stubStateService{record: state.Record{Key: "myapp||order-1", Value: "{}", Size: 2}}
	b := stubStateBackend{svc: svc}

	// A key with the || delimiter and non-ASCII text must round-trip.
	key := "myapp||órder||42"
	w := doState(t, b, http.MethodGet, "/record?key="+url.QueryEscape(key), "")
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, key, svc.lastKey)

	t.Run("missing key parameter is a 400", func(t *testing.T) {
		w := doState(t, b, http.MethodGet, "/record", "")
		require.Equal(t, http.StatusBadRequest, w.Code)
		require.Contains(t, w.Body.String(), "key is required")
	})

	t.Run("not found is a 404", func(t *testing.T) {
		nf := &stubStateService{recordErr: state.ErrNotFound}
		w := doState(t, stubStateBackend{svc: nf}, http.MethodGet, "/record?key=k", "")
		require.Equal(t, http.StatusNotFound, w.Code)
		require.Contains(t, w.Body.String(), "record not found")
	})
}

func TestStateAppIDsNeverReturnsNullJSON(t *testing.T) {
	svc := &stubStateService{appIDs: nil}
	w := doState(t, stubStateBackend{svc: svc}, http.MethodGet, "/appids", "")
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `[]`, w.Body.String())
}

// The dropdown must offer only prefixes that have visible records under the
// current filter, so /appids honours includeInternal exactly as / does.
func TestStateAppIDsForwardsIncludeInternal(t *testing.T) {
	t.Run("absent means app keys only", func(t *testing.T) {
		svc := &stubStateService{appIDs: []string{"alpha"}}
		w := doState(t, stubStateBackend{svc: svc}, http.MethodGet, "/appids", "")
		require.Equal(t, http.StatusOK, w.Code)
		require.False(t, svc.lastAppIDsInternal)
	})

	t.Run("includeInternal=true widens the list", func(t *testing.T) {
		svc := &stubStateService{appIDs: []string{"alpha", "gamma"}}
		w := doState(t, stubStateBackend{svc: svc}, http.MethodGet, "/appids?includeInternal=true", "")
		require.Equal(t, http.StatusOK, w.Code)
		require.True(t, svc.lastAppIDsInternal)
	})

	t.Run("any other value stays false", func(t *testing.T) {
		svc := &stubStateService{appIDs: []string{"alpha"}}
		w := doState(t, stubStateBackend{svc: svc}, http.MethodGet, "/appids?includeInternal=1", "")
		require.Equal(t, http.StatusOK, w.Code)
		require.False(t, svc.lastAppIDsInternal, "only the literal \"true\" enables it, as / does")
	})
}

func TestStateDelete(t *testing.T) {
	svc := &stubStateService{deletes: []state.DeleteResult{
		{Key: "a", OK: true},
		{Key: "b", Error: "boom"},
	}}
	b := stubStateBackend{svc: svc}

	w := doState(t, b, http.MethodPost, "/delete", `{"keys":["a","b"]}`)
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"a", "b"}, svc.lastDeletes)
	var got []state.DeleteResult
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Len(t, got, 2)
	require.True(t, got[0].OK)
	require.False(t, got[1].OK)

	t.Run("invalid JSON is a 400", func(t *testing.T) {
		w := doState(t, b, http.MethodPost, "/delete", `{`)
		require.Equal(t, http.StatusBadRequest, w.Code)
	})
	t.Run("empty key list is a 400", func(t *testing.T) {
		w := doState(t, b, http.MethodPost, "/delete", `{"keys":[]}`)
		require.Equal(t, http.StatusBadRequest, w.Code)
		require.Contains(t, w.Body.String(), "keys is required")
	})
}

func TestStateCreateRecord(t *testing.T) {
	svc := &stubStateService{}
	b := stubStateBackend{svc: svc}

	w := doState(t, b, http.MethodPost, "/record",
		`{"appId":"order-app","key":"cart-1","value":"hello"}`)
	require.Equal(t, http.StatusCreated, w.Code)
	require.Equal(t, state.SetRequest{AppID: "order-app", Key: "cart-1", Value: "hello"}, svc.lastSet)
	// The response names the composed key so the SPA can report what it created
	// without duplicating the delimiter rule.
	require.JSONEq(t, `{"key":"order-app||cart-1"}`, w.Body.String())

	t.Run("overwrite is forwarded", func(t *testing.T) {
		w := doState(t, b, http.MethodPost, "/record",
			`{"appId":"a","key":"k","value":"v","overwrite":true}`)
		require.Equal(t, http.StatusCreated, w.Code)
		require.True(t, svc.lastSet.Overwrite)
	})

	t.Run("an empty value is accepted", func(t *testing.T) {
		w := doState(t, b, http.MethodPost, "/record", `{"appId":"a","key":"k","value":""}`)
		require.Equal(t, http.StatusCreated, w.Code)
		require.Equal(t, "", svc.lastSet.Value)
	})

	t.Run("invalid JSON is a 400", func(t *testing.T) {
		w := doState(t, b, http.MethodPost, "/record", `{`)
		require.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("a missing appId or key is a 400", func(t *testing.T) {
		for _, body := range []string{
			`{"appId":"","key":"k","value":"v"}`,
			`{"appId":"a","key":"","value":"v"}`,
		} {
			w := doState(t, b, http.MethodPost, "/record", body)
			require.Equal(t, http.StatusBadRequest, w.Code, body)
			require.Contains(t, w.Body.String(), "required")
		}
	})

	// A typed delimiter would compose a key that classify() reads as actor
	// state, so the new record would hide behind "Show internal keys".
	t.Run("a delimiter in appId or key is a 400", func(t *testing.T) {
		for _, body := range []string{
			`{"appId":"a||b","key":"k","value":"v"}`,
			`{"appId":"a","key":"k||sub","value":"v"}`,
		} {
			w := doState(t, b, http.MethodPost, "/record", body)
			require.Equal(t, http.StatusBadRequest, w.Code, body)
			require.Contains(t, w.Body.String(), "||")
		}
	})

	t.Run("an existing key is a 409", func(t *testing.T) {
		ex := &stubStateService{setErr: state.ErrExists}
		w := doState(t, stubStateBackend{svc: ex}, http.MethodPost, "/record",
			`{"appId":"a","key":"k","value":"v"}`)
		require.Equal(t, http.StatusConflict, w.Code)
		require.Contains(t, w.Body.String(), "already exists")
	})

	t.Run("an unreachable store is a 503", func(t *testing.T) {
		un := &stubStateService{setErr: state.ErrStoreUnreachable}
		w := doState(t, stubStateBackend{svc: un}, http.MethodPost, "/record",
			`{"appId":"a","key":"k","value":"v"}`)
		require.Equal(t, http.StatusServiceUnavailable, w.Code)
	})

	t.Run("an unknown store is a 404", func(t *testing.T) {
		w := doState(t, stubStateBackend{unknown: true}, http.MethodPost, "/record",
			`{"appId":"a","key":"k","value":"v"}`)
		require.Equal(t, http.StatusNotFound, w.Code)
		require.Contains(t, w.Body.String(), "unknown state store")
	})
}
