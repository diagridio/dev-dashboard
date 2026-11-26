package server

import (
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/go-chi/chi/v5"
)

// newsRouter returns an http.Handler for the /news sub-tree.
// GET / returns the latest news content slots as JSON. When hidePromotion is
// true the promotion slot is always null; the other slots are unchanged.
func newsRouter(svc news.Service, hidePromotion bool) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		resp := svc.Get(req.Context()) // a copy; safe to modify
		if hidePromotion {
			resp.Promotion = nil
		}
		writeJSON(w, http.StatusOK, resp)
	})
	return r
}
