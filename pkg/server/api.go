package server

import (
	"encoding/json"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/go-chi/chi/v5"
)

// apiRouter builds the JSON API surface served under /api.
func apiRouter(v version.Info) http.Handler {
	r := chi.NewRouter()
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, v)
	})
	return r
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
