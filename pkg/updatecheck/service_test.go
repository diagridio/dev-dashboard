//go:build unit

package updatecheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// latestServer serves the GitHub /releases/latest shape and counts hits.
func latestServer(t *testing.T, tag string, hits *int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		require.Equal(t, "/repos/diagridio/dev-dashboard/releases/latest", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"` + tag + `"}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestServiceCheckReportsUpdate(t *testing.T) {
	var hits int32
	srv := latestServer(t, "v1.3.0", &hits)
	svc := New(srv.Client(), srv.URL, "diagridio/dev-dashboard", "1.2.0", time.Hour)

	r := svc.Check(context.Background())
	require.True(t, r.UpdateAvailable)
	require.Equal(t, "v1.3.0", r.Latest)
	require.Equal(t, "https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0", r.ReleaseURL)
}

func TestServiceCachesWithinTTL(t *testing.T) {
	var hits int32
	srv := latestServer(t, "v1.3.0", &hits)
	svc := New(srv.Client(), srv.URL, "diagridio/dev-dashboard", "1.2.0", time.Hour)

	_ = svc.Check(context.Background())
	_ = svc.Check(context.Background())
	require.Equal(t, int32(1), atomic.LoadInt32(&hits), "second Check should hit cache")
}

func TestServiceNegativeCacheOnError(t *testing.T) {
	var hits int32
	// Server that always 500s.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	svc := New(srv.Client(), srv.URL, "diagridio/dev-dashboard", "1.2.0", time.Hour)

	r1 := svc.Check(context.Background())
	require.False(t, r1.UpdateAvailable)
	r2 := svc.Check(context.Background())
	require.False(t, r2.UpdateAvailable)
	require.Equal(t, int32(1), atomic.LoadInt32(&hits), "failed fetch should be negative-cached, not re-probed")
}

func TestServiceSkipsNetworkForDevBuild(t *testing.T) {
	var hits int32
	srv := latestServer(t, "v1.3.0", &hits)
	svc := New(srv.Client(), srv.URL, "diagridio/dev-dashboard", "dev", time.Hour)

	r := svc.Check(context.Background())
	require.False(t, r.UpdateAvailable)
	require.Equal(t, int32(0), atomic.LoadInt32(&hits), "dev build must not hit the network")
}

func TestServicePreservesLastGoodOnLaterFailure(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&calls, 1) == 1 {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"tag_name":"v1.3.0"}`))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	// A tiny ttl forces the second Check to re-fetch (positive cache already
	// expired) rather than serving the cached value, so we exercise the error
	// path with a non-zero last-good already present.
	svc := New(srv.Client(), srv.URL, "diagridio/dev-dashboard", "1.2.0", time.Microsecond)

	first := svc.Check(context.Background())
	require.True(t, first.UpdateAvailable)
	require.Equal(t, "v1.3.0", first.Latest)

	// Sleep to ensure positive cache expires before second Check.
	time.Sleep(2 * time.Microsecond)

	// The second fetch fails; the non-zero last-good result must be preserved.
	second := svc.Check(context.Background())
	require.Equal(t, first, second)
	require.GreaterOrEqual(t, atomic.LoadInt32(&calls), int32(2), "second Check should have attempted a re-fetch")
}
