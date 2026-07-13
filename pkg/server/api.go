package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/diagridio/dev-dashboard/pkg/controlplane"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/lifecycle"
	"github.com/diagridio/dev-dashboard/pkg/metadata"
	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/go-chi/chi/v5"
)

// apiRouter builds the JSON API surface served under /api.
func apiRouter(v version.Info, apps discovery.Service, containerLogs func(context.Context, string) (<-chan string, error), life lifecycle.Manager, backend WorkflowBackend, stores StoreRegistry, res resources.Service, newsSvc news.Service, cp controlplane.Manager, uc updatecheck.Service, caps Capabilities) http.Handler {
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
				writeJSON(w, storeErrStatus(err), map[string]string{"error": err.Error()})
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
			newID, err := stores.UpdateStore(id, body.Name, body.Type, body.Metadata)
			if err != nil {
				writeJSON(w, storeErrStatus(err), map[string]string{"error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]string{"id": newID})
		})
		sr.Delete("/{id}", func(w http.ResponseWriter, req *http.Request) {
			if stores == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
				return
			}
			if err := stores.DeleteStore(chi.URLParam(req, "id")); err != nil {
				writeJSON(w, storeErrStatus(err), map[string]string{"error": err.Error()})
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	})
	r.Mount("/apps", appsRouter(apps, containerLogs, life, caps))
	r.Mount("/actors", actorsRouter(apps))
	r.Mount("/subscriptions", subscriptionsRouter(apps))
	if caps.Workflows {
		r.Mount("/workflows", workflowsRouter(backend, stores))
	}
	r.Mount("/resources", resourcesRouter(res, apps))
	r.Mount("/news", newsRouter(newsSvc))
	if caps.ControlPlane {
		r.Mount("/controlplane", controlPlaneRouter(cp))
	}
	if uc != nil {
		r.Mount("/update-check", updateCheckRouter(uc))
	}
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
	// ErrActiveStore rejects deleting the elected active store (mapped to 409).
	ErrActiveStore = errors.New("cannot remove the active workflow state store")
)

// storeErrStatus maps registry mutation failures to HTTP status codes by
// sentinel (errors.Is, never message text): a duplicate name (os.ErrExist) is
// a 409 conflict, a missing id (os.ErrNotExist) is a 404, and anything else —
// e.g. a registry file write failure — is a server error, not the client's
// fault. Request validation failures are rejected with 400 before the registry
// is called, so they never reach this mapping.
func storeErrStatus(err error) int {
	switch {
	case errors.Is(err, ErrActiveStore):
		return http.StatusConflict
	case errors.Is(err, os.ErrExist):
		return http.StatusConflict
	case errors.Is(err, os.ErrNotExist):
		return http.StatusNotFound
	default:
		return http.StatusInternalServerError
	}
}

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
	"state.mongodb":    true,
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
