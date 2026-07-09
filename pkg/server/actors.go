package server

import (
	"net/http"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/go-chi/chi/v5"
)

// ActorRow is a single actor-type entry returned by GET /api/actors.
type ActorRow struct {
	AppID       string `json:"appId"`
	InstanceKey string `json:"instanceKey"`
	Type        string `json:"type"`
	Count       int    `json:"count"`
	Placement   string `json:"placement,omitempty"`
}

// instanceKey returns the instance's routing identity, tolerating fixtures
// (and any pre-InstanceKey producer) that only set AppID.
func instanceKey(in discovery.Instance) string {
	if in.InstanceKey != "" {
		return in.InstanceKey
	}
	return in.AppID
}

func actorsRouter(apps discovery.Service) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		list, err := apps.List(req.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		filter := req.URL.Query().Get("appId")
		rows := []ActorRow{}
		for _, in := range list {
			if filter != "" && in.AppID != filter {
				continue
			}
			for _, a := range in.Actors {
				rows = append(rows, ActorRow{AppID: in.AppID, InstanceKey: instanceKey(in), Type: a.Type, Count: a.Count, Placement: in.Placement})
			}
		}
		sort.SliceStable(rows, func(i, j int) bool {
			if rows[i].AppID != rows[j].AppID {
				return rows[i].AppID < rows[j].AppID
			}
			return rows[i].Type < rows[j].Type
		})
		writeJSON(w, http.StatusOK, rows)
	})
	return r
}
