//go:build unit

package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/stretchr/testify/require"
)

// mutableStoreRegistry is a StoreRegistry double recording mutator calls.
type mutableStoreRegistry struct {
	stores    []StoreInfo
	added     []StoreInfo
	updated   []StoreInfo
	deleted   []string
	addErr    error
	updateErr error
	deleteErr error
}

func (m *mutableStoreRegistry) Stores() []StoreInfo { return m.stores }

func (m *mutableStoreRegistry) AddStore(name, typ string, metadata map[string]string) error {
	if m.addErr != nil {
		return m.addErr
	}
	// The real reconciler delegates to the registry, which assigns a stable id
	// from the name; the double mirrors that so tests can assert an id is set.
	m.added = append(m.added, StoreInfo{ID: "id-" + name, Name: name, Type: typ, Source: "manual"})
	return nil
}

func (m *mutableStoreRegistry) UpdateStore(id, name, typ string, metadata map[string]string) error {
	if m.updateErr != nil {
		return m.updateErr
	}
	m.updated = append(m.updated, StoreInfo{ID: id, Name: name, Type: typ, Source: "manual"})
	return nil
}

func (m *mutableStoreRegistry) DeleteStore(id string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	m.deleted = append(m.deleted, id)
	return nil
}

func newAPI(stores StoreRegistry) http.Handler {
	return apiRouter(version.Info{}, nil, newFakeBackend(fakeWF{}), stores, fakeResources{}, fakeNews{})
}

func doReq(t *testing.T, h http.Handler, req *http.Request) (*http.Response, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func putJSON(t *testing.T, h http.Handler, path, body string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	return doReq(t, h, req)
}

func TestStateStores_PostValidType(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	res, _ := postJSON(t, h, "/statestores",
		`{"name":"pg","type":"state.postgresql","metadata":{"connectionString":"host=a"}}`)
	// Handler contract: 201 Created on success.
	require.Equal(t, http.StatusCreated, res.StatusCode)
	// AddStore must have been called once with the posted values.
	require.Len(t, reg.added, 1)
	require.Equal(t, "pg", reg.added[0].Name)
	require.Equal(t, "state.postgresql", reg.added[0].Type)
	// ID assignment is the registry's responsibility, not the handler's — not asserted here.
}

func TestStateStores_PostUnsupportedType(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	res, _ := postJSON(t, h, "/statestores", `{"name":"x","type":"state.mongodb","metadata":{}}`)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
	require.Len(t, reg.added, 0)
}

func TestStateStores_PostMissingName(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	res, _ := postJSON(t, h, "/statestores", `{"name":"","type":"state.redis","metadata":{}}`)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestStateStores_Delete(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	// The path param is the entry id.
	req, _ := http.NewRequest(http.MethodDelete, "/statestores/abc123def456", nil)
	res, _ := doReq(t, h, req)
	require.Equal(t, http.StatusNoContent, res.StatusCode)
	require.Equal(t, []string{"abc123def456"}, reg.deleted)
}

func TestStateStores_PutUpdates(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	// The path param is the entry id; the body carries the new values.
	req, body := putJSON(t, h, "/statestores/abc123def456",
		`{"name":"pg","type":"state.postgresql","metadata":{"connectionString":"host=b"}}`)
	require.Equal(t, http.StatusOK, req.StatusCode, body)
	require.Len(t, reg.updated, 1)
	require.Equal(t, "abc123def456", reg.updated[0].ID)
}
