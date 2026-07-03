package server

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/controlplane"
	"github.com/go-chi/chi/v5"
)

func controlPlaneRouter(mgr controlplane.Manager) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		res, err := mgr.List(req.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
	r.Post("/{name}/{action}", func(w http.ResponseWriter, req *http.Request) {
		name := chi.URLParam(req, "name")
		action := chi.URLParam(req, "action")
		err := mgr.Do(req.Context(), action, name)
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		case errors.Is(err, controlplane.ErrInvalidAction), errors.Is(err, controlplane.ErrUnknownService):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		case errors.Is(err, controlplane.ErrRuntimeUnavailable):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		}
	})
	r.Get("/{name}/logs", func(w http.ResponseWriter, req *http.Request) {
		name := chi.URLParam(req, "name")
		ch, err := mgr.LogStream(req.Context(), name)
		if err != nil {
			status := http.StatusBadGateway
			if errors.Is(err, controlplane.ErrUnknownService) {
				status = http.StatusBadRequest
			} else if errors.Is(err, controlplane.ErrRuntimeUnavailable) {
				status = http.StatusServiceUnavailable
			}
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
		for {
			select {
			case line, open := <-ch:
				if !open {
					return
				}
				_, _ = fmt.Fprintf(w, "data: %s\n\n", line)
				flusher.Flush()
			case <-req.Context().Done():
				return
			}
		}
	})
	return r
}
