package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/logs"
	"github.com/go-chi/chi/v5"
)

var (
	ansiRE      = regexp.MustCompile(`\x1b\[[0-9;]*m`)
	dcpPrefixRE = regexp.MustCompile(`^\d+\s+\S+Z\s+`)
)

// normalizeLine cleans a captured log line for display. For DCP-captured lines
// (format "dcp") it strips the leading "<seq> <RFC3339-UTC> " prefix that Aspire's
// orchestrator prepends. For all formats it strips ANSI color escape codes.
func normalizeLine(line, format string) string {
	if format == "dcp" {
		line = dcpPrefixRE.ReplaceAllString(line, "")
	}
	return ansiRE.ReplaceAllString(line, "")
}

func logsHandler(svc discovery.Service, containerLogs func(context.Context, string) (<-chan string, error)) http.HandlerFunc {
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
		if req.URL.Query().Get("source") == "app" {
			source = "app"
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}

		var ch <-chan string
		format := ""
		if in.Source == discovery.SourceCompose {
			id := in.DaprdContainerID
			if source == "app" {
				id = in.AppContainerID
			}
			if id == "" || containerLogs == nil {
				log.Warn("container log source unavailable", "app", appID, "source", source)
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "no container logs for this app/source"})
				return
			}
			ch, err = containerLogs(req.Context(), id)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
		} else {
			path := in.DaprdLogPath
			format = in.DaprdLogFormat
			if source == "app" {
				path, format = in.AppLogPath, in.AppLogFormat
			}
			if path == "" {
				log.Warn("log stream source unavailable", "app", appID, "source", source, "path", path)
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "no log file for this app/source"})
				return
			}
			ch, err = logs.Tail(req.Context(), path, 200, 500*time.Millisecond)
			if err != nil {
				log.Warn("log stream source unavailable", "app", appID, "source", source, "path", path, "err", err)
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
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
				_, _ = fmt.Fprintf(w, "data: %s\n\n", normalizeLine(line, format))
				flusher.Flush()
			case <-req.Context().Done():
				return
			}
		}
	}
}
