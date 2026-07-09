package server

import (
	"context"
	"errors"
	"net/http"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/go-chi/chi/v5"
)

func resourcesRouter(res resources.Service, apps discovery.Service) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		kind := resources.Kind(req.URL.Query().Get("kind"))
		if kind != resources.KindComponent && kind != resources.KindConfiguration {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be component or configuration"})
			return
		}
		list, err := res.List(req.Context(), kind)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if kind == resources.KindComponent {
			loaded := loadedByIndex(req.Context(), apps)
			for i := range list {
				list[i].LoadedBy = loaded[list[i].Name]
			}
		}
		if list == nil {
			list = []resources.Resource{}
		}
		writeJSON(w, http.StatusOK, list)
	})
	r.Get("/{kind}/{name}", func(w http.ResponseWriter, req *http.Request) {
		kind := resources.Kind(chi.URLParam(req, "kind"))
		if kind != resources.KindComponent && kind != resources.KindConfiguration {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be component or configuration"})
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
		if kind == resources.KindComponent {
			got.LoadedBy = loadedByFor(req.Context(), apps, got.Name)
		}
		writeJSON(w, http.StatusOK, got)
	})
	return r
}

// loadedByFor returns the sorted instance keys whose instance contains component name.
// It lists apps once and scans only for the requested name, avoiding a full index build.
func loadedByFor(ctx context.Context, apps discovery.Service, name string) []string {
	list, err := apps.List(ctx)
	if err != nil {
		return nil
	}
	var ids []string
	for _, in := range list {
		for _, c := range in.Components {
			if c.Name == name {
				ids = append(ids, instanceKey(in))
				break
			}
		}
	}
	sort.Strings(ids)
	return ids
}

// loadedByIndex maps component name -> sorted instance keys that loaded it.
func loadedByIndex(ctx context.Context, apps discovery.Service) map[string][]string {
	idx := map[string][]string{}
	list, err := apps.List(ctx)
	if err != nil {
		return idx
	}
	for _, in := range list {
		for _, c := range in.Components {
			idx[c.Name] = append(idx[c.Name], instanceKey(in))
		}
	}
	for k := range idx {
		sort.Strings(idx[k])
	}
	return idx
}
