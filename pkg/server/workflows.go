package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/go-chi/chi/v5"
)

// WorkflowRemover is the removal surface the API needs (impl: *workflow.Remover).
type WorkflowRemover interface {
	RemoveMany(ctx context.Context, targets []workflow.RemoveTarget, force bool) []workflow.RemoveResult
}

// StoreRegistry exposes detected/active state stores to the API (Task 12).
type StoreRegistry interface {
	Stores() []StoreInfo
}

// StoreInfo describes the active detected state store.
type StoreInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Path       string `json:"path"`
	Active     bool   `json:"active"`
	Connection string `json:"connection"` // secrets-free host/db summary for display
}

// TargetResolver resolves an (appID, instanceID) pair into a RemoveTarget.
// Implemented in cmd (Task 13) by combining discovery.Service + workflow.Service.
type TargetResolver interface {
	Resolve(ctx context.Context, appID, instanceID string) (workflow.RemoveTarget, error)
}

// WorkflowBackend selects the workflow service/remover/resolver for a named
// state store. An empty name selects the active store; ok=false means the
// named store is unknown.
type WorkflowBackend interface {
	ServiceFor(store string) (svc workflow.Service, rem WorkflowRemover, targets TargetResolver, ok bool)
}

// removeBody is the request body for single and bulk removal endpoints.
type removeBody struct {
	IDs   []targetRef `json:"ids"`
	Force bool        `json:"force"`
}

// targetRef identifies a single workflow instance in a bulk request.
type targetRef struct {
	AppID      string `json:"appId"`
	InstanceID string `json:"instanceId"`
}

func workflowsRouter(backend WorkflowBackend, stores StoreRegistry) http.Handler {
	r := chi.NewRouter()

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		svc, _, _, ok := backend.ServiceFor(req.URL.Query().Get("store"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown state store"})
			return
		}
		q := parseListQuery(req)
		res, err := svc.List(req.Context(), q)
		if errors.Is(err, workflow.ErrNoStore) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	r.Get("/stats", func(w http.ResponseWriter, req *http.Request) {
		svc, _, _, ok := backend.ServiceFor(req.URL.Query().Get("store"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown state store"})
			return
		}
		res, err := svc.Stats(req.Context(), parseListQuery(req))
		if errors.Is(err, workflow.ErrNoStore) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	r.Get("/{appId}/{instanceId}", func(w http.ResponseWriter, req *http.Request) {
		svc, _, _, ok := backend.ServiceFor(req.URL.Query().Get("store"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown state store"})
			return
		}
		ex, err := svc.Get(req.Context(), chi.URLParam(req, "appId"), chi.URLParam(req, "instanceId"))
		switch {
		case errors.Is(err, workflow.ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow not found"})
		case errors.Is(err, workflow.ErrNoStore):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
		case err != nil:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusOK, ex)
		}
	})

	r.Post("/purge", func(w http.ResponseWriter, req *http.Request) {
		_, rem, targets, ok := backend.ServiceFor(req.URL.Query().Get("store"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown state store"})
			return
		}
		var body removeBody
		_ = json.NewDecoder(req.Body).Decode(&body)
		var tgts []workflow.RemoveTarget
		var failed []workflow.RemoveResult
		for _, ref := range body.IDs {
			t, err := targets.Resolve(req.Context(), ref.AppID, ref.InstanceID)
			if err != nil {
				failed = append(failed, workflow.RemoveResult{InstanceID: ref.InstanceID, OK: false, Error: "could not resolve target"})
				continue
			}
			tgts = append(tgts, t)
		}
		results := rem.RemoveMany(req.Context(), tgts, body.Force)
		writeJSON(w, http.StatusOK, append(results, failed...))
	})

	return r
}

func parseListQuery(req *http.Request) workflow.ListQuery {
	q := workflow.ListQuery{
		AppID:     req.URL.Query().Get("appId"),
		Search:    req.URL.Query().Get("search"),
		PageToken: req.URL.Query().Get("page"),
	}
	if s := req.URL.Query().Get("status"); s != "" {
		for _, part := range strings.Split(s, ",") {
			if part = strings.TrimSpace(part); part != "" {
				q.Status = append(q.Status, workflow.Status(part))
			}
		}
	}
	if l := req.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil {
			q.PageSize = n
		}
	}
	return q
}
