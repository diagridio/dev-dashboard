package server

import (
	"bytes"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// SPAHandler serves static assets from fsys and falls back to index.html for
// unknown paths so client-side (History-API) routing works. basePath is the
// optional subpath the app is mounted under ("" for root). telemetryEnabled
// is injected into the served index.html as window.__DASH_TELEMETRY_ENABLED__
// so the front-end knows whether to load Datadog RUM.
func SPAHandler(fsys fs.FS, basePath string, telemetryEnabled bool) http.Handler {
	basePath = "/" + strings.Trim(basePath, "/")
	fileServer := http.FileServer(http.FS(fsys))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upath := strings.TrimPrefix(r.URL.Path, basePath)
		upath = "/" + strings.TrimPrefix(upath, "/")

		if name := strings.TrimPrefix(upath, "/"); name != "" {
			if f, err := fsys.Open(name); err == nil {
				info, statErr := f.Stat()
				_ = f.Close()
				// Serve regular files only: directories would get an
				// http.FileServer auto-index of embedded assets, so treat
				// them as a miss and use the SPA/404 fallback below.
				if statErr == nil && !info.IsDir() {
					r2 := r.Clone(r.Context())
					r2.URL.Path = upath
					fileServer.ServeHTTP(w, r2)
					return
				}
			}
		}
		// Missing path: only fall back to the SPA shell for client routes
		// (no file extension). Missing static assets must 404, not return HTML.
		if path.Ext(upath) != "" {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r, fsys, telemetryEnabled)
	})
}

func serveIndex(w http.ResponseWriter, _ *http.Request, fsys fs.FS, telemetryEnabled bool) {
	data, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}
	flag := "false"
	if telemetryEnabled {
		flag = "true"
	}
	script := []byte("<script>window.__DASH_TELEMETRY_ENABLED__=" + flag + ";</script></head>")
	data = bytes.Replace(data, []byte("</head>"), script, 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
