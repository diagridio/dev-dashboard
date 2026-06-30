package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/metadata"
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
	r.Get("/metadata/components", metadata.HandleGetComponents)
	r.Route("/statestores", func(sr chi.Router) {
		sr.Get("/", func(w http.ResponseWriter, _ *http.Request) {
			if stores == nil {
				writeJSON(w, http.StatusOK, []StoreInfo{})
				return
			}
			writeJSON(w, http.StatusOK, stores.Stores())
		})
		sr.Post("/", func(w http.ResponseWriter, req *http.Request) {
			if stores == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
				return
			}
			var body storeBody
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
			if err := validateStoreBody(body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := stores.AddStore(body.Name, body.Type, body.Metadata); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusCreated, map[string]string{"name": body.Name})
		})
		sr.Put("/{id}", func(w http.ResponseWriter, req *http.Request) {
			if stores == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
				return
			}
			id := chi.URLParam(req, "id")
			var body storeBody
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
			if err := validateStoreBody(body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			if err := stores.UpdateStore(id, body.Name, body.Type, body.Metadata); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"id": id})
		})
		sr.Delete("/{id}", func(w http.ResponseWriter, req *http.Request) {
			if stores == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
				return
			}
			if err := stores.DeleteStore(chi.URLParam(req, "id")); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
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

// ErrUnsupportedStoreType / ErrStoreValidation map validation failures to 400.
var (
	ErrUnsupportedStoreType = errors.New("unsupported state store type")
	ErrStoreValidation      = errors.New("invalid store request")
)

// storeBody is the POST/PUT request body for a manual connection.
type storeBody struct {
	Name     string            `json:"name"`
	Type     string            `json:"type"`
	Metadata map[string]string `json:"metadata"`
}

// supportedStoreTypes is the closed set the registry accepts for manual entries.
var supportedStoreTypes = map[string]bool{
	"state.redis":      true,
	"state.sqlite":     true,
	"state.postgresql": true,
}

// validateStoreBody enforces required fields and the supported-type allowlist.
func validateStoreBody(b storeBody) error {
	if b.Name == "" {
		return fmt.Errorf("%w: name is required", ErrStoreValidation)
	}
	if !supportedStoreTypes[b.Type] {
		return fmt.Errorf("%w: %s", ErrUnsupportedStoreType, b.Type)
	}
	if len(b.Metadata) == 0 {
		return fmt.Errorf("%w: metadata is required", ErrStoreValidation)
	}
	return nil
}
