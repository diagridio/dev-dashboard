package server

import (
	"net/http"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/go-chi/chi/v5"
)

// SubscriptionRow is a single subscription entry returned by GET /api/subscriptions.
type SubscriptionRow struct {
	AppID           string              `json:"appId"`
	PubsubName      string              `json:"pubsubName"`
	Topic           string              `json:"topic"`
	Rules           []discovery.SubRule `json:"rules,omitempty"`
	DeadLetterTopic string              `json:"deadLetterTopic,omitempty"`
	Type            string              `json:"type,omitempty"`
}

func subscriptionsRouter(apps discovery.Service) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		list, err := apps.List(req.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		filter := req.URL.Query().Get("appId")
		rows := []SubscriptionRow{}
		for _, in := range list {
			if filter != "" && in.AppID != filter {
				continue
			}
			for _, s := range in.Subscriptions {
				rows = append(rows, SubscriptionRow{
					AppID:           in.AppID,
					PubsubName:      s.PubsubName,
					Topic:           s.Topic,
					Rules:           s.Rules,
					DeadLetterTopic: s.DeadLetterTopic,
					Type:            s.Type,
				})
			}
		}
		sort.SliceStable(rows, func(i, j int) bool {
			if rows[i].AppID != rows[j].AppID {
				return rows[i].AppID < rows[j].AppID
			}
			if rows[i].PubsubName != rows[j].PubsubName {
				return rows[i].PubsubName < rows[j].PubsubName
			}
			return rows[i].Topic < rows[j].Topic
		})
		writeJSON(w, http.StatusOK, rows)
	})
	return r
}
