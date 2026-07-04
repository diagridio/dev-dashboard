//go:build unit

package selfupdate

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestHTTPGetOKAndNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ok" {
			_, _ = w.Write([]byte("body-bytes"))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	body, err := httpGet(context.Background(), srv.Client(), srv.URL+"/ok")
	require.NoError(t, err)
	require.Equal(t, []byte("body-bytes"), body)

	_, err = httpGet(context.Background(), srv.Client(), srv.URL+"/missing")
	require.ErrorIs(t, err, errNotFound)
}

func TestResolveLatest(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"tag_name":"v1.2.0"}`))
	}))
	defer srv.Close()

	v, err := resolveLatest(context.Background(), srv.Client(), srv.URL, "diagridio/dev-dashboard")
	require.NoError(t, err)
	require.Equal(t, "v1.2.0", v)
	require.Equal(t, "/repos/diagridio/dev-dashboard/releases/latest", gotPath)
}

func TestHTTPGetServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	_, err := httpGet(context.Background(), srv.Client(), srv.URL+"/any")
	require.Error(t, err)
	require.NotErrorIs(t, err, errNotFound)
}

func TestHTTPGetOversizedBodyErrors(t *testing.T) {
	prev := maxDownloadBytes
	maxDownloadBytes = 16 // shrink the cap so the test stays tiny
	t.Cleanup(func() { maxDownloadBytes = prev })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("x"), 64)) // 64 > 16-byte cap
	}))
	defer srv.Close()

	_, err := httpGet(context.Background(), srv.Client(), srv.URL+"/big")
	require.Error(t, err, "a body larger than the cap must error, not be truncated silently")
	require.NotErrorIs(t, err, errNotFound)
	require.Contains(t, err.Error(), "exceeds", "the error must say the size cap was exceeded")

	// A body exactly at the cap still succeeds.
	srvOK := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(bytes.Repeat([]byte("y"), 16))
	}))
	defer srvOK.Close()
	body, err := httpGet(context.Background(), srvOK.Client(), srvOK.URL+"/fit")
	require.NoError(t, err)
	require.Len(t, body, 16)
}

func TestResolveLatestEmptyTag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	_, err := resolveLatest(context.Background(), srv.Client(), srv.URL, "diagridio/dev-dashboard")
	require.Error(t, err)
	require.False(t, errors.Is(err, errNotFound))
}
