package server

import (
	"encoding/json"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/go-chi/chi/v5"
)

// apiRouter builds the JSON API surface served under /api.
func apiRouter(v version.Info, apps discovery.Service, backend WorkflowBackend, stores StoreRegistry, res resources.Service, newsSvc news.Service) http.Handler {
	r := chi.NewRouter()
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, v)
	})
	r.Get("/statestores", func(w http.ResponseWriter, _ *http.Request) {
		if stores == nil {
			writeJSON(w, http.StatusOK, []StoreInfo{})
			return
		}
		writeJSON(w, http.StatusOK, stores.Stores())
	})
	r.Mount("/apps", appsRouter(apps))
	r.Mount("/actors", actorsRouter(apps))
	r.Mount("/subscriptions", subscriptionsRouter(apps))
	r.Mount("/workflows", workflowsRouter(backend, stores))
	r.Mount("/resources", resourcesRouter(res, apps))
	r.Mount("/news", newsRouter(newsSvc))
	return r
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
