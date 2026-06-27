package server

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/logs"
	"github.com/go-chi/chi/v5"
)

func logsHandler(svc discovery.Service) http.HandlerFunc {
	log := slog.Default().With("component", "server")
	return func(w http.ResponseWriter, req *http.Request) {
		appID := chi.URLParam(req, "appId")
		in, err := svc.Get(req.Context(), appID)
		if errors.Is(err, discovery.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "app not found"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		source := "daprd"
		path := in.DaprdLogPath
		if req.URL.Query().Get("source") == "app" {
			source = "app"
			path = in.AppLogPath
		}
		if path == "" {
			log.Warn("log stream source unavailable", "app", appID, "source", source)
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no log file for this app/source"})
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}
		ch, err := logs.Tail(req.Context(), path, 200, 500*time.Millisecond)
		if err != nil {
			log.Warn("log stream source unavailable", "app", appID, "source", source, "path", path, "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
		log.Info("log stream opened", "app", appID, "source", source)
		defer log.Info("log stream closed", "app", appID)
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
	}
}
