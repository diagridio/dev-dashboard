package server

import (
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/go-chi/chi/v5"
)

// newsRouter returns an http.Handler for the /news sub-tree.
// GET / returns the latest news content slots as JSON.
func newsRouter(svc news.Service) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		writeJSON(w, http.StatusOK, svc.Get(req.Context()))
	})
	return r
}
