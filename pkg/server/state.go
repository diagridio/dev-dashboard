package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/state"
	"github.com/go-chi/chi/v5"
)

// StateBackend selects the state service for a named store. An empty name
// selects the active store; ok=false means the named store is unknown.
type StateBackend interface {
	StateFor(store string) (state.Service, bool)
}

// deleteBody is the request body for the bulk delete endpoint.
type deleteBody struct {
	Keys []string `json:"keys"`
}

// createBody is the request body for the record create endpoint. Value is
// stored verbatim; an empty string is a valid record, so it is not optional in
// the sense of being defaulted.
type createBody struct {
	AppID     string `json:"appId"`
	Key       string `json:"key"`
	Value     string `json:"value"`
	Overwrite bool   `json:"overwrite"`
}

func stateRouter(backend StateBackend) http.Handler {
	r := chi.NewRouter()

	// svcFor resolves the store from ?store=, writing the 404 itself when the
	// store is unknown.
	svcFor := func(w http.ResponseWriter, req *http.Request) (state.Service, bool) {
		svc, ok := backend.StateFor(req.URL.Query().Get("store"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown state store"})
			return nil, false
		}
		return svc, true
	}

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		svc, ok := svcFor(w, req)
		if !ok {
			return
		}
		res, err := svc.List(req.Context(), parseStateQuery(req))
		if err != nil {
			writeStateErr(w, err)
			return
		}
		if res.Items == nil {
			res.Items = []state.Item{}
		}
		writeJSON(w, http.StatusOK, res)
	})

	r.Get("/record", func(w http.ResponseWriter, req *http.Request) {
		svc, ok := svcFor(w, req)
		if !ok {
			return
		}
		// The key is a query parameter, not a path segment: keys contain "||"
		// and arbitrary characters, which path escaping handles badly.
		key := req.URL.Query().Get("key")
		if key == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key is required"})
			return
		}
		rec, err := svc.Record(req.Context(), key)
		if err != nil {
			writeStateErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rec)
	})

	// POST on the same path as the record read: GET /record returns one record,
	// POST /record creates one. The key is composed here from appId and key
	// rather than accepted whole, so a caller cannot write a three-segment key
	// that the listing would classify as actor state.
	r.Post("/record", func(w http.ResponseWriter, req *http.Request) {
		svc, ok := svcFor(w, req)
		if !ok {
			return
		}
		var body createBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if body.AppID == "" || body.Key == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "appId and key are required"})
			return
		}
		if strings.Contains(body.AppID, state.Delimiter) || strings.Contains(body.Key, state.Delimiter) {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": `appId and key cannot contain "||"`,
			})
			return
		}
		err := svc.Set(req.Context(), state.SetRequest{
			AppID:     body.AppID,
			Key:       body.Key,
			Value:     body.Value,
			Overwrite: body.Overwrite,
		})
		if err != nil {
			writeStateErr(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"key": state.ComposeKey(body.AppID, body.Key)})
	})

	r.Get("/appids", func(w http.ResponseWriter, req *http.Request) {
		svc, ok := svcFor(w, req)
		if !ok {
			return
		}
		// Same spelling as the list route: only the literal "true" opts in.
		includeInternal := req.URL.Query().Get("includeInternal") == "true"
		ids, err := svc.AppIDs(req.Context(), includeInternal)
		if err != nil {
			writeStateErr(w, err)
			return
		}
		if ids == nil {
			ids = []string{} // never serialize a bare null to the SPA
		}
		writeJSON(w, http.StatusOK, ids)
	})

	r.Post("/delete", func(w http.ResponseWriter, req *http.Request) {
		svc, ok := svcFor(w, req)
		if !ok {
			return
		}
		var body deleteBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if len(body.Keys) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keys is required"})
			return
		}
		writeJSON(w, http.StatusOK, svc.Delete(req.Context(), body.Keys))
	})

	return r
}

// writeStateErr maps service errors to status codes by sentinel, never by
// message text. The 503 bodies match the workflow endpoints' shapes so the
// SPA's shared banner extraction keeps working.
//
// There is deliberately no 400 for a bad search pattern: every fragment of
// user input is escaped before it reaches KeysLike, so a pattern error would
// be our bug, not the caller's, and belongs in the 500 bucket.
func writeStateErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, state.ErrNoStore):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
	case errors.Is(err, state.ErrStoreUnreachable):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
	case errors.Is(err, state.ErrNotBrowsable):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "this state store cannot be browsed"})
	case errors.Is(err, state.ErrExists):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, state.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "record not found"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}

// parseStateQuery reads the list query parameters. The limit shares
// maxListPageSize with the workflow list: each returned row costs value bytes,
// so an unbounded limit would let one request pull an unbounded page.
func parseStateQuery(req *http.Request) state.ListQuery {
	q := state.ListQuery{
		AppID:     req.URL.Query().Get("appId"),
		Search:    req.URL.Query().Get("search"),
		PageToken: req.URL.Query().Get("page"),
	}
	if req.URL.Query().Get("includeInternal") == "true" {
		q.IncludeInternal = true
	}
	if l := req.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil {
			switch {
			case n > maxListPageSize:
				q.PageSize = maxListPageSize
			case n > 0:
				q.PageSize = n
				// n <= 0: leave PageSize at 0 so the service default applies.
			}
		}
	}
	return q
}
