package server

import (
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/go-chi/chi/v5"
)

// updateCheckRouter returns an http.Handler for the /update-check sub-tree.
// GET / returns whether a newer release is available as JSON.
func updateCheckRouter(svc updatecheck.Service) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		writeJSON(w, http.StatusOK, svc.Check(req.Context()))
	})
	return r
}
