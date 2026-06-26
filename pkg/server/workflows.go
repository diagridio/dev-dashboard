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

// StoreInfo describes a single detected state store.
type StoreInfo struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Path   string `json:"path"`
	Active bool   `json:"active"`
}

// TargetResolver resolves an (appID, instanceID) pair into a RemoveTarget.
// Implemented in cmd (Task 13) by combining discovery.Service + workflow.Service.
type TargetResolver interface {
	Resolve(ctx context.Context, appID, instanceID string) (workflow.RemoveTarget, error)
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

func workflowsRouter(svc workflow.Service, rem WorkflowRemover, stores StoreRegistry, targets TargetResolver) http.Handler {
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

	r.Post("/{appId}/{instanceId}/terminate", removeOne(rem, targets))
	r.Post("/{appId}/{instanceId}/purge", removeOne(rem, targets))

	r.Post("/purge", func(w http.ResponseWriter, req *http.Request) {
		var body removeBody
		_ = json.NewDecoder(req.Body).Decode(&body)
		var tgts []workflow.RemoveTarget
		for _, ref := range body.IDs {
			t, err := targets.Resolve(req.Context(), ref.AppID, ref.InstanceID)
			if err != nil {
				continue
			}
			tgts = append(tgts, t)
		}
		writeJSON(w, http.StatusOK, rem.RemoveMany(req.Context(), tgts, body.Force))
	})

	return r
}

// removeOne returns an http.HandlerFunc for single-instance terminate/purge.
func removeOne(rem WorkflowRemover, targets TargetResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		var body removeBody
		_ = json.NewDecoder(req.Body).Decode(&body)
		t, err := targets.Resolve(req.Context(), chi.URLParam(req, "appId"), chi.URLParam(req, "instanceId"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow not found"})
			return
		}
		results := rem.RemoveMany(req.Context(), []workflow.RemoveTarget{t}, body.Force)
		if len(results) == 1 {
			writeJSON(w, http.StatusOK, results[0])
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "removal produced no result"})
	}
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
