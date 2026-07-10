//go:build unit

package server

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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

func (m *mutableStoreRegistry) UpdateStore(id, name, typ string, metadata map[string]string) (string, error) {
	if m.updateErr != nil {
		return "", m.updateErr
	}
	newID := "id-" + name // mirror the registry recomputing id from name
	m.updated = append(m.updated, StoreInfo{ID: newID, Name: name, Type: typ, Source: "manual"})
	return newID, nil
}

func (m *mutableStoreRegistry) DeleteStore(id string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	m.deleted = append(m.deleted, id)
	return nil
}

func newAPI(stores StoreRegistry) http.Handler {
	return apiRouter(version.Info{}, nil, nil, nil, newFakeBackend(fakeWF{}), stores, fakeResources{}, fakeNews{}, nil, fakeUpdateCheck{})
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

// TestStateStores_MutationErrorStatusCodes pins the error-class → HTTP status
// mapping for the three store mutators: duplicates (os.ErrExist, possibly
// wrapped) are 409, missing ids (os.ErrNotExist) are 404, and anything else —
// e.g. a registry file write failure — is a server-side 500, never a 400.
func TestStateStores_MutationErrorStatusCodes(t *testing.T) {
	cases := []struct {
		name       string
		err        error
		wantStatus int
	}{
		{name: "duplicate is 409", err: os.ErrExist, wantStatus: http.StatusConflict},
		{name: "wrapped duplicate is 409", err: fmt.Errorf("a connection named %q already exists: %w", "pg", os.ErrExist), wantStatus: http.StatusConflict},
		{name: "missing id is 404", err: os.ErrNotExist, wantStatus: http.StatusNotFound},
		{name: "wrapped missing id is 404", err: fmt.Errorf("no connection with id %q: %w", "abc", os.ErrNotExist), wantStatus: http.StatusNotFound},
		{name: "io failure is 500", err: errors.New("disk full"), wantStatus: http.StatusInternalServerError},
	}

	const validBody = `{"name":"pg","type":"state.postgresql","metadata":{"connectionString":"host=a"}}`

	for _, tc := range cases {
		t.Run("add: "+tc.name, func(t *testing.T) {
			reg := &mutableStoreRegistry{addErr: tc.err}
			h := newAPI(reg)
			res, body := postJSON(t, h, "/statestores", validBody)
			require.Equal(t, tc.wantStatus, res.StatusCode, body)
			// Error shape stays {"error": "..."} regardless of status.
			require.Contains(t, body, `"error"`)
			require.Len(t, reg.added, 0)
		})
		t.Run("update: "+tc.name, func(t *testing.T) {
			reg := &mutableStoreRegistry{updateErr: tc.err}
			h := newAPI(reg)
			res, body := putJSON(t, h, "/statestores/abc123def456", validBody)
			require.Equal(t, tc.wantStatus, res.StatusCode, body)
			require.Contains(t, body, `"error"`)
			require.Len(t, reg.updated, 0)
		})
		t.Run("delete: "+tc.name, func(t *testing.T) {
			reg := &mutableStoreRegistry{deleteErr: tc.err}
			h := newAPI(reg)
			req, _ := http.NewRequest(http.MethodDelete, "/statestores/abc123def456", nil)
			res, body := doReq(t, h, req)
			require.Equal(t, tc.wantStatus, res.StatusCode, body)
			require.Contains(t, body, `"error"`)
			require.Len(t, reg.deleted, 0)
		})
	}
}

func TestStateStores_PutUpdates(t *testing.T) {
	reg := &mutableStoreRegistry{}
	h := newAPI(reg)
	req, body := putJSON(t, h, "/statestores/abc123def456",
		`{"name":"pg","type":"state.postgresql","metadata":{"connectionString":"host=b"}}`)
	require.Equal(t, http.StatusOK, req.StatusCode, body)
	require.Len(t, reg.updated, 1)
	require.Equal(t, "id-pg", reg.updated[0].ID)
	require.Contains(t, body, `"id":"id-pg"`)
}

func TestDeleteStatestoreActiveConflict(t *testing.T) {
	m := &mutableStoreRegistry{deleteErr: ErrActiveStore}
	h := newAPI(m)

	req := httptest.NewRequest(http.MethodDelete, "/statestores/abc123", nil)
	res, body := doReq(t, h, req)
	require.Equal(t, http.StatusConflict, res.StatusCode)
	require.Contains(t, body, "active workflow state store")
	require.Empty(t, m.deleted)
}
