//go:build unit

package selfupdate

import (
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

func TestResolveLatestEmptyTag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	_, err := resolveLatest(context.Background(), srv.Client(), srv.URL, "diagridio/dev-dashboard")
	require.Error(t, err)
	require.False(t, errors.Is(err, errNotFound))
}
