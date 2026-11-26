package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"

	"github.com/diagridio/dev-dashboard/pkg/actors"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/go-chi/chi/v5"
)

// ActorsService is the actors surface the API needs (satisfied by *actors.Service).
type ActorsService interface {
	List(ctx context.Context, appID string) ([]actors.TypeRow, error)
	Type(ctx context.Context, instanceKey, actorType string) (actors.TypeDetail, error)
	Actor(ctx context.Context, instanceKey, actorType, actorID string) (actors.ActorDetail, error)
	Invoke(ctx context.Context, instanceKey, actorType, actorID string, r actors.InvokeRequest) (actors.InvokeResult, error)
	DeleteReminder(ctx context.Context, instanceKey, actorType, actorID, name string) error
}

// instanceKey returns the instance's routing identity, tolerating fixtures
// (and any pre-InstanceKey producer) that only set AppID.
func instanceKey(in discovery.Instance) string {
	if in.InstanceKey != "" {
		return in.InstanceKey
	}
	return in.AppID
}

// pathParam returns a URL-decoded chi param. chi matches on RawPath only when
// Go kept one (an escape the default encoding wouldn't produce, like "%2F"),
// so a param arrives still escaped only then; otherwise it is already decoded
// and must not be decoded again.
func pathParam(req *http.Request, name string) string {
	v := chi.URLParam(req, name)
	if req.URL.RawPath == "" {
		return v
	}
	if d, err := url.PathUnescape(v); err == nil {
		return d
	}
	return v
}

// actorErrStatus maps service errors to HTTP status codes. fallback is used
// for anything else (daprd or network errors).
func actorErrStatus(err error, fallback int) int {
	switch {
	case errors.Is(err, actors.ErrInternalType), errors.Is(err, actors.ErrInvalidRequest):
		return http.StatusBadRequest
	case errors.Is(err, discovery.ErrNotFound):
		return http.StatusNotFound
	case errors.Is(err, actors.ErrSidecarUnreachable):
		return http.StatusServiceUnavailable
	}
	return fallback
}

func writeActorErr(w http.ResponseWriter, err error, fallback int) {
	writeJSON(w, actorErrStatus(err, fallback), map[string]string{"error": err.Error()})
}

// actorsRouter serves /api/actors. A nil svc lists no actors and answers the
// other routes with 503.
func actorsRouter(svc ActorsService) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		if svc == nil {
			writeJSON(w, http.StatusOK, []actors.TypeRow{})
			return
		}
		rows, err := svc.List(req.Context(), req.URL.Query().Get("appId"))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if rows == nil {
			rows = []actors.TypeRow{}
		}
		writeJSON(w, http.StatusOK, rows)
	})
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if svc == nil {
					writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "actors unavailable"})
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		r.Get("/{appId}/{actorType}", func(w http.ResponseWriter, req *http.Request) {
			d, err := svc.Type(req.Context(), pathParam(req, "appId"), pathParam(req, "actorType"))
			if err != nil {
				writeActorErr(w, err, http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, d)
		})
		r.Get("/{appId}/{actorType}/{actorId}", func(w http.ResponseWriter, req *http.Request) {
			d, err := svc.Actor(req.Context(), pathParam(req, "appId"), pathParam(req, "actorType"), pathParam(req, "actorId"))
			if err != nil {
				writeActorErr(w, err, http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusOK, d)
		})
		r.Post("/{appId}/{actorType}/{actorId}/invoke", func(w http.ResponseWriter, req *http.Request) {
			var body actors.InvokeRequest
			if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
				return
			}
			res, err := svc.Invoke(req.Context(), pathParam(req, "appId"), pathParam(req, "actorType"), pathParam(req, "actorId"), body)
			if err != nil {
				writeActorErr(w, err, http.StatusBadGateway)
				return
			}
			writeJSON(w, http.StatusOK, res)
		})
		r.Delete("/{appId}/{actorType}/{actorId}/reminders/{name}", func(w http.ResponseWriter, req *http.Request) {
			err := svc.DeleteReminder(req.Context(), pathParam(req, "appId"), pathParam(req, "actorType"), pathParam(req, "actorId"), pathParam(req, "name"))
			if err != nil {
				writeActorErr(w, err, http.StatusBadGateway)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
	})
	return r
}
