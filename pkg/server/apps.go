package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/go-chi/chi/v5"
)

// appsRouter builds the /apps sub-router backed by the given discovery service.
func appsRouter(svc discovery.Service, containerLogs func(context.Context, string) (<-chan string, error)) http.Handler {
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

	return r
}
