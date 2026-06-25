package server

import (
	"io"
	"io/fs"
	"net/http"
	"strings"
	"time"
)

// SPAHandler serves static assets from fsys and falls back to index.html for
// unknown paths so client-side (History-API) routing works. basePath is the
// optional subpath the app is mounted under ("" for root).
func SPAHandler(fsys fs.FS, basePath string) http.Handler {
	basePath = "/" + strings.Trim(basePath, "/")
	fileServer := http.FileServer(http.FS(fsys))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upath := strings.TrimPrefix(r.URL.Path, basePath)
		upath = "/" + strings.TrimPrefix(upath, "/")

		// Existing file? serve it. Otherwise serve index.html (SPA fallback).
		if name := strings.TrimPrefix(upath, "/"); name != "" {
			if f, err := fsys.Open(name); err == nil {
				_ = f.Close()
				r2 := r.Clone(r.Context())
				r2.URL.Path = upath
				fileServer.ServeHTTP(w, r2)
				return
			}
		}
		serveIndex(w, r, fsys)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	f, err := fsys.Open("index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}
	defer func() { _ = f.Close() }()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if rs, ok := f.(io.ReadSeeker); ok {
		http.ServeContent(w, r, "index.html", time.Time{}, rs)
		return
	}
	_, _ = io.Copy(w, f)
}
