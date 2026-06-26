package server

import (
	"context"
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

// StoreInfo describes a single detected state store.
type StoreInfo struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Path   string `json:"path"`
	Active bool   `json:"active"`
}

func workflowsRouter(svc workflow.Service, rem WorkflowRemover, stores StoreRegistry) http.Handler {
	r := chi.NewRouter()

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
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

	r.Get("/{appId}/{instanceId}", func(w http.ResponseWriter, req *http.Request) {
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

	// removal + statestores handlers added in Task 12
	_ = rem
	_ = stores
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
