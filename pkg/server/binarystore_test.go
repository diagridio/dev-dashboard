//go:build unit

package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/binarystore"
	"github.com/go-chi/chi/v5"
)

type fakeBinReader struct {
	data []byte
	err  error

	appKey, store, key string
	size               int64
	calls              int
}

func (f *fakeBinReader) Read(_ context.Context, appKey, store, key string, size int64) ([]byte, error) {
	f.calls++
	f.appKey, f.store, f.key, f.size = appKey, store, key, size
	return f.data, f.err
}

func binRouter(f BinaryFileReader) http.Handler {
	r := chi.NewRouter()
	r.Get("/api/apps/{appId}/binarystore/{store}/file", binaryFileHandler(f))
	return r
}

func binGet(h http.Handler, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func TestBinaryStoreHandler_Success(t *testing.T) {
	f := &fakeBinReader{data: []byte{0, 1, 2, 0xff}}
	rec := binGet(binRouter(f), "/api/apps/order/binarystore/blobs/file?key=k")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("content-type %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("cache-control %q", cc)
	}
	b, _ := io.ReadAll(rec.Body)
	if string(b) != string(f.data) {
		t.Fatalf("body %v", b)
	}
}

func TestBinaryStoreHandler_EmptyFile(t *testing.T) {
	rec := binGet(binRouter(&fakeBinReader{}), "/api/apps/a/binarystore/s/file?key=k")
	if rec.Code != 200 || rec.Body.Len() != 0 {
		t.Fatalf("status %d len %d", rec.Code, rec.Body.Len())
	}
}

func TestBinaryStoreHandler_KeyQueryParamDecoded(t *testing.T) {
	f := &fakeBinReader{}
	rec := binGet(binRouter(f), "/api/apps/order/binarystore/blobs/file?key=workflow-payloads%2Forder%2042%2F%C3%A9&size=131102")
	if rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	if f.appKey != "order" || f.store != "blobs" || f.key != "workflow-payloads/order 42/é" || f.size != 131102 {
		t.Fatalf("got %q %q %q %d", f.appKey, f.store, f.key, f.size)
	}
}

func TestBinaryStoreHandler_MissingKey(t *testing.T) {
	f := &fakeBinReader{}
	for _, u := range []string{"/api/apps/a/binarystore/s/file", "/api/apps/a/binarystore/s/file?key=%20"} {
		rec := binGet(binRouter(f), u)
		if rec.Code != 400 || !contains(rec.Body.String(), "key is required") {
			t.Fatalf("%s: %d %s", u, rec.Code, rec.Body.String())
		}
	}
	if f.calls != 0 {
		t.Fatal("reader called")
	}
}

func TestBinaryStoreHandler_BadSize(t *testing.T) {
	f := &fakeBinReader{}
	for _, s := range []string{"abc", "-1", "1.5"} {
		rec := binGet(binRouter(f), "/api/apps/a/binarystore/s/file?key=k&size="+s)
		if rec.Code != 400 || !contains(rec.Body.String(), "size must be a non-negative integer") {
			t.Fatalf("%s: %d %s", s, rec.Code, rec.Body.String())
		}
	}
	if f.calls != 0 {
		t.Fatal("reader called")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestBinaryStoreHandler_ErrorMapping(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"app", &binarystore.Error{Kind: binarystore.KindAppNotFound, Msg: "m"}, 404},
		{"sidecar", &binarystore.Error{Kind: binarystore.KindSidecarUnreachable, Msg: "m"}, 503},
		{"store", &binarystore.Error{Kind: binarystore.KindStoreNotLoaded, Msg: "m"}, 400},
		{"file", &binarystore.Error{Kind: binarystore.KindFileNotFound, Msg: "m"}, 404},
		{"invalid", &binarystore.Error{Kind: binarystore.KindInvalid, Msg: "m"}, 400},
		{"unsupported", &binarystore.Error{Kind: binarystore.KindUnsupported, Msg: "m"}, 400},
		{"toolarge", &binarystore.Error{Kind: binarystore.KindTooLarge, Msg: "m", Size: 2000000}, 413},
		{"upstream-unavail", &binarystore.Error{Kind: binarystore.KindUpstream, Msg: "m", Unavailable: true}, 503},
		{"upstream", &binarystore.Error{Kind: binarystore.KindUpstream, Msg: "m"}, 502},
		{"plain", io.ErrUnexpectedEOF, 500},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := binGet(binRouter(&fakeBinReader{err: c.err}), "/api/apps/a/binarystore/s/file?key=k")
			if rec.Code != c.want {
				t.Fatalf("status %d want %d", rec.Code, c.want)
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["error"] == "" || body["error"] == nil {
				t.Fatalf("no error: %v", body)
			}
			if c.name == "toolarge" && body["size"] != float64(2000000) {
				t.Fatalf("size: %v", body)
			}
		})
	}
}
