package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/go-chi/chi/v5"
)

func resourcesRouter(res resources.Service, apps discovery.Service, revealEnabled bool) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		kind := resources.Kind(req.URL.Query().Get("kind"))
		if !validKind(kind) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be component, configuration or resiliency"})
			return
		}
		list, err := res.List(req.Context(), kind)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		loaded := loadedByIndex(req.Context(), apps, kind)
		for i := range list {
			list[i].LoadedBy = loaded[loadedKey(list[i])]
		}
		if list == nil {
			list = []resources.Resource{}
		}
		writeJSON(w, http.StatusOK, list)
	})
	r.Get("/{kind}/{name}", func(w http.ResponseWriter, req *http.Request) {
		kind := resources.Kind(chi.URLParam(req, "kind"))
		if !validKind(kind) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be component, configuration or resiliency"})
			return
		}
		idOrName := chi.URLParam(req, "name")
		got, err := res.Get(req.Context(), kind, idOrName)
		if errors.Is(err, resources.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "resource not found"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		got.LoadedBy = loadedByFor(req.Context(), apps, kind, loadedKey(got))
		writeJSON(w, http.StatusOK, got)
	})
	r.Post("/component/{id}/secret-value", func(w http.ResponseWriter, req *http.Request) {
		if !revealEnabled {
			writeJSON(w, http.StatusForbidden,
				map[string]string{"error": "secret reveal is disabled when the dashboard is served off-host"})
			return
		}
		var body struct {
			Field string `json:"field"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil || body.Field == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "field is required"})
			return
		}
		id := chi.URLParam(req, "id")
		val, err := res.RevealSecret(req.Context(), id, body.Field)
		if errors.Is(err, resources.ErrNotFound) || errors.Is(err, resources.ErrNoSecretValue) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no resolved secret for that field"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		slog.Default().With("component", "resources").Info("secret revealed", "resource", id, "field", body.Field)
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]string{"value": val})
	})
	return r
}

// validKind reports whether kind is served by the resources API.
func validKind(kind resources.Kind) bool {
	switch kind {
	case resources.KindComponent, resources.KindConfiguration, resources.KindResiliency:
		return true
	}
	return false
}

// loadedKey is what loadedNames reports for r: its file path for a
// Configuration (daprd's metadata does not name its configuration, so the
// link is the app's --config file, compared canonically), its name for
// everything else.
func loadedKey(r resources.Resource) string {
	if r.Kind == resources.KindConfiguration {
		return resources.CanonicalPath(r.Path)
	}
	return r.Name
}

// loadedNames returns the keys (see loadedKey) of the resources of kind an
// instance's sidecar has loaded.
func loadedNames(in discovery.Instance, kind resources.Kind) []string {
	var names []string
	switch kind {
	case resources.KindConfiguration:
		if in.ConfigPath != "" {
			names = append(names, resources.CanonicalPath(in.ConfigPath))
		}
	case resources.KindComponent:
		for _, c := range in.Components {
			names = append(names, c.Name)
		}
	case resources.KindResiliency:
		for _, r := range in.Resiliencies {
			names = append(names, r.Name)
		}
	}
	return names
}

// loadedByFor returns the sorted instance keys that loaded the resource of
// kind whose loadedKey is key. It lists apps once and checks only that key,
// avoiding a full index build.
func loadedByFor(ctx context.Context, apps discovery.Service, kind resources.Kind, key string) []string {
	list, err := apps.List(ctx)
	if err != nil {
		return nil
	}
	var ids []string
	for _, in := range list {
		if slices.Contains(loadedNames(in, kind), key) {
			ids = append(ids, instanceKey(in))
		}
	}
	sort.Strings(ids)
	return ids
}

// loadedByIndex maps loadedKey -> sorted instance keys that loaded it.
func loadedByIndex(ctx context.Context, apps discovery.Service, kind resources.Kind) map[string][]string {
	idx := map[string][]string{}
	list, err := apps.List(ctx)
	if err != nil {
		return idx
	}
	for _, in := range list {
		for _, n := range loadedNames(in, kind) {
			idx[n] = append(idx[n], instanceKey(in))
		}
	}
	for k := range idx {
		sort.Strings(idx[k])
	}
	return idx
}
