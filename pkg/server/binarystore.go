package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/binarystore"
	"github.com/go-chi/chi/v5"
)

// BinaryFileReader reads one file from a binary store component via an app's
// sidecar. Implemented by *binarystore.Service.
type BinaryFileReader interface {
	Read(ctx context.Context, appKey, store, key string, declaredSize int64) ([]byte, error)
}

// binaryFileHandler serves GET /api/apps/{appId}/binarystore/{store}/file
// ?key=<key>&size=<declared>. The key travels as a query parameter so it
// reaches the sidecar byte-for-byte. The payload is written raw (never
// JSON-encoded); an empty file is a 200 with an empty body.
func binaryFileHandler(rd BinaryFileReader) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query()
		key := q.Get("key")
		if strings.TrimSpace(key) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key is required"})
			return
		}
		var size int64
		if s := q.Get("size"); s != "" {
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil || n < 0 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "size must be a non-negative integer"})
				return
			}
			size = n
		}
		data, err := rd.Read(req.Context(), chi.URLParam(req, "appId"), chi.URLParam(req, "store"), key, size)
		if err != nil {
			var be *binarystore.Error
			if !errors.As(err, &be) {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			body := map[string]any{"error": be.Msg}
			if be.Kind == binarystore.KindTooLarge {
				body["size"] = be.Size
			}
			writeJSON(w, binaryErrStatus(be), body)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}

func binaryErrStatus(e *binarystore.Error) int {
	switch e.Kind {
	case binarystore.KindAppNotFound, binarystore.KindFileNotFound:
		return http.StatusNotFound
	case binarystore.KindSidecarUnreachable:
		return http.StatusServiceUnavailable
	case binarystore.KindStoreNotLoaded, binarystore.KindInvalid, binarystore.KindUnsupported:
		return http.StatusBadRequest
	case binarystore.KindTooLarge:
		return http.StatusRequestEntityTooLarge
	case binarystore.KindUpstream:
		if e.Unavailable {
			return http.StatusServiceUnavailable
		}
		return http.StatusBadGateway
	}
	return http.StatusInternalServerError
}
