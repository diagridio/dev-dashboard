package server

import (
	"errors"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/go-chi/chi/v5"
)

// appsRouter builds the /apps sub-router backed by the given discovery service.
func appsRouter(svc discovery.Service) http.Handler {
	r := chi.NewRouter()

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		instances, err := svc.List(req.Context())
		if err != nil {
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, instances)
	})

	r.Get("/{appId}", func(w http.ResponseWriter, req *http.Request) {
		appID := chi.URLParam(req, "appId")
		instance, err := svc.Get(req.Context(), appID)
		if err != nil {
			if errors.Is(err, discovery.ErrNotFound) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, instance)
	})

	return r
}
