package server

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/logs"
	"github.com/go-chi/chi/v5"
)

func logsHandler(svc discovery.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		in, err := svc.Get(req.Context(), chi.URLParam(req, "appId"))
		if errors.Is(err, discovery.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "app not found"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		path := in.DaprdLogPath
		if req.URL.Query().Get("source") == "app" {
			path = in.AppLogPath
		}
		if path == "" {
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
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
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
	}
}
