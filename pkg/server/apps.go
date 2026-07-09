package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/lifecycle"
	"github.com/go-chi/chi/v5"
)

// appsRouter builds the /apps sub-router backed by the given discovery
// service and lifecycle manager (nil disables lifecycle actions).
func appsRouter(svc discovery.Service, containerLogs func(context.Context, string) (<-chan string, error), life lifecycle.Manager) http.Handler {
	r := chi.NewRouter()

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		items, err := svc.List(req.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, items)
	})

	r.Get("/{appId}", func(w http.ResponseWriter, req *http.Request) {
		in, err := svc.Get(req.Context(), chi.URLParam(req, "appId"))
		if errors.Is(err, discovery.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "app not found"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, in)
	})

	r.Get("/{appId}/logs", logsHandler(svc, containerLogs))

	r.Post("/{appId}/{target}/{action}", func(w http.ResponseWriter, req *http.Request) {
		if life == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "lifecycle actions unavailable"})
			return
		}
		err := life.Do(req.Context(),
			chi.URLParam(req, "appId"),
			lifecycle.Target(chi.URLParam(req, "target")),
			lifecycle.Action(chi.URLParam(req, "action")))
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		case errors.Is(err, lifecycle.ErrInvalidTarget), errors.Is(err, lifecycle.ErrInvalidAction), errors.Is(err, lifecycle.ErrUnsupported):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		case errors.Is(err, discovery.ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "app not found"})
		case errors.Is(err, lifecycle.ErrRuntimeUnavailable):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		}
	})

	return r
}
