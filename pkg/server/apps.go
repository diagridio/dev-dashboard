package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/lifecycle"
	"github.com/go-chi/chi/v5"
)

// appsRouter builds the /apps sub-router backed by the given discovery
// service and lifecycle manager (nil disables lifecycle actions). caps gates
// the logs and lifecycle-action routes (list/detail stay unconditional).
func appsRouter(svc discovery.Service, containerLogs func(context.Context, string) (<-chan string, error), life lifecycle.Manager, caps Capabilities) http.Handler {
	r := chi.NewRouter()

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		items, err := svc.List(req.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, items)
	})

	r.Get("/{appId}", func(w http.ResponseWriter, req *http.Request) {
		in, err := svc.Get(req.Context(), chi.URLParam(req, "appId"))
		if errors.Is(err, discovery.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "app not found"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, in)
	})

	r.Post("/{appId}/publish", publishHandler(svc))

	if caps.Logs {
		r.Get("/{appId}/logs", logsHandler(svc, containerLogs))
	}

	if caps.Lifecycle {
		r.Post("/{appId}/{target}/{action}", func(w http.ResponseWriter, req *http.Request) {
			if life == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "lifecycle actions unavailable"})
				return
			}
			err := life.Do(req.Context(),
				chi.URLParam(req, "appId"),
				lifecycle.Target(chi.URLParam(req, "target")),
				lifecycle.Action(chi.URLParam(req, "action")))
			switch {
			case err == nil:
				writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
			case errors.Is(err, lifecycle.ErrInvalidTarget), errors.Is(err, lifecycle.ErrInvalidAction), errors.Is(err, lifecycle.ErrUnsupported):
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			case errors.Is(err, discovery.ErrNotFound):
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "app not found"})
			case errors.Is(err, lifecycle.ErrRuntimeUnavailable):
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			default:
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			}
		})
	}

	r.Delete("/{appId}", func(w http.ResponseWriter, req *http.Request) {
		if life == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "lifecycle actions unavailable"})
			return
		}
		err := life.Forget(req.Context(), chi.URLParam(req, "appId"))
		switch {
		case err == nil:
			w.WriteHeader(http.StatusNoContent)
		case errors.Is(err, discovery.ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no remembered stopped instance for this app"})
		default:
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		}
	})

	return r
}

// publishClient proxies publish requests to sidecars. Its timeout bounds a
// single publish; the sidecar is always local (loopback or aspire proxy).
var publishClient = &http.Client{Timeout: 10 * time.Second}

// publishBody is the POST /api/apps/{appId}/publish request body.
type publishBody struct {
	PubsubName  string            `json:"pubsubName"`
	Topic       string            `json:"topic"`
	Data        string            `json:"data"`
	ContentType string            `json:"contentType"`
	Metadata    map[string]string `json:"metadata"`
}

// publishHandler proxies a message to the resolved instance's sidecar
// /v1.0/publish/{pubsub}/{topic}. daprd errors are surfaced verbatim.
func publishHandler(svc discovery.Service) http.HandlerFunc {
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
		if !in.SidecarReachable {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sidecar unreachable"})
			return
		}
		var body publishBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if body.Topic == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "topic is required"})
			return
		}
		if !hasPubsubComponent(in, body.PubsubName) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("unknown pub/sub component: %s", body.PubsubName)})
			return
		}
		contentType := body.ContentType
		if contentType == "" {
			contentType = "application/json"
		}
		u := fmt.Sprintf("%s/v1.0/publish/%s/%s", in.BaseURL(), url.PathEscape(body.PubsubName), url.PathEscape(body.Topic))
		if len(body.Metadata) > 0 {
			q := make(url.Values)
			for k, v := range body.Metadata {
				q.Set("metadata."+k, v)
			}
			u += "?" + q.Encode()
		}
		preq, err := http.NewRequestWithContext(req.Context(), http.MethodPost, u, strings.NewReader(body.Data))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		preq.Header.Set("Content-Type", contentType)
		resp, err := publishClient.Do(preq)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			writeJSON(w, http.StatusOK, map[string]string{"status": "published"})
			return
		}
		msg, _ := io.ReadAll(resp.Body)
		writeJSON(w, resp.StatusCode, map[string]string{"error": daprdErrorMessage(msg)})
	}
}

// daprdErrorMessage extracts a human-readable message from a daprd error
// response body, which is normally JSON of the form
// {"errorCode":"...","message":"..."}. It falls back to the error code, then
// the trimmed raw body, if the message field is empty or the body isn't the
// expected shape.
func daprdErrorMessage(body []byte) string {
	var parsed struct {
		Message   string `json:"message"`
		ErrorCode string `json:"errorCode"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil {
		if parsed.Message != "" {
			return parsed.Message
		}
		if parsed.ErrorCode != "" {
			return parsed.ErrorCode
		}
	}
	return strings.TrimSpace(string(body))
}

// hasPubsubComponent reports whether the instance exposes a pub/sub component
// with the given name (type prefixed "pubsub.").
func hasPubsubComponent(in discovery.Instance, name string) bool {
	for _, c := range in.Components {
		if c.Name == name && strings.HasPrefix(c.Type, "pubsub.") {
			return true
		}
	}
	return false
}
