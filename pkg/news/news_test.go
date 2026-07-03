//go:build unit

package news

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const feedJSON = `{
  "latestBlogPosts":[{"title":"Blog A","url":"https://x/blog-a"}],
  "latestReports":[{"title":"Report A","url":"https://x/report-a"}],
  "upcomingWebinars":[{"title":"Past WB","url":"https://x/wb-past","eventStartDate":"2020-01-01T00:00:00Z"},{"title":"Future WB","url":"https://x/wb-future","eventStartDate":"2099-01-01T00:00:00Z"}],
  "upcomingEvents":[{"title":"Future EV","url":"https://x/ev","eventStartDate":"2099-06-01T00:00:00Z","eventLocation":"Berlin"}]
}`

func TestNewsSlotsAndCache(t *testing.T) {
	var calls int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(feedJSON))
	}))
	defer ts.Close()

	svc := New(&http.Client{Timeout: 2 * time.Second}, ts.URL, time.Hour)
	r := svc.Get(context.Background())
	require.NotNil(t, r.Blog)
	require.Equal(t, "Blog A", r.Blog.Title)
	require.NotNil(t, r.Report)
	require.NotNil(t, r.Webinar)
	require.Equal(t, "Future WB", r.Webinar.Title) // past one skipped
	require.NotNil(t, r.Event)
	require.Equal(t, "Berlin", r.Event.EventLocation)

	_ = svc.Get(context.Background()) // within ttl → cached
	require.Equal(t, int32(1), atomic.LoadInt32(&calls))
}

func TestNewsLastGoodOnFailure(t *testing.T) {
	var fail atomic.Bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			w.WriteHeader(500)
			return
		}
		_, _ = w.Write([]byte(feedJSON))
	}))
	defer ts.Close()

	svc := New(&http.Client{Timeout: 2 * time.Second}, ts.URL, time.Nanosecond) // always stale
	r1 := svc.Get(context.Background())
	require.NotNil(t, r1.Blog)
	fail.Store(true)
	time.Sleep(time.Millisecond)
	r2 := svc.Get(context.Background()) // refetch fails → last-good
	require.NotNil(t, r2.Blog)
	require.Equal(t, "Blog A", r2.Blog.Title)
}

// TestNewsStaleServedDuringSlowRefresh verifies that when the cache is stale
// but a last-good response exists, concurrent Gets return the stale data
// promptly (without blocking on the in-flight upstream fetch) and the
// upstream receives exactly one refresh request.
func TestNewsStaleServedDuringSlowRefresh(t *testing.T) {
	var calls int32
	release := make(chan struct{})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n > 1 {
			<-release // hold every refresh request until the test releases it
		}
		_, _ = w.Write([]byte(feedJSON))
	}))
	defer ts.Close()
	defer close(release)

	svc := New(&http.Client{Timeout: 5 * time.Second}, ts.URL, 30*time.Millisecond)
	r := svc.Get(context.Background()) // prime last-good
	require.NotNil(t, r.Blog)
	time.Sleep(50 * time.Millisecond) // let the cache go stale

	const n = 10
	results := make(chan Response, n)
	start := time.Now()
	for i := 0; i < n; i++ {
		go func() {
			results <- svc.Get(context.Background())
		}()
	}
	for i := 0; i < n; i++ {
		select {
		case got := <-results:
			require.NotNil(t, got.Blog)
			require.Equal(t, "Blog A", got.Blog.Title)
		case <-time.After(2 * time.Second):
			t.Fatal("Get blocked behind the in-flight refresh instead of serving stale data")
		}
	}
	// Generous bound: callers must not have waited on the (still-blocked) upstream.
	require.Less(t, time.Since(start), 1*time.Second, "stale callers should return promptly")

	// Wait for the (single, background) refresh request to reach upstream,
	// then confirm no further requests were issued: it is still parked on the
	// handler, so exactly one refresh is in flight.
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&calls) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond) // grace period for any extra (buggy) refreshes
	require.Equal(t, int32(2), atomic.LoadInt32(&calls), "expected exactly 1 refresh request (plus the priming request)")
}

// TestNewsSingleflightNoLastGood verifies that when there is no last-good
// response and upstream is failing, N concurrent Gets share a single upstream
// request, and a follow-up Get within the negative TTL does not hit upstream.
func TestNewsSingleflightNoLastGood(t *testing.T) {
	var calls int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		time.Sleep(200 * time.Millisecond) // ensure concurrent callers overlap the fetch
		w.WriteHeader(500)
	}))
	defer ts.Close()

	svc := New(&http.Client{Timeout: 5 * time.Second}, ts.URL, time.Hour)

	const n = 10
	done := make(chan Response, n)
	for i := 0; i < n; i++ {
		go func() {
			done <- svc.Get(context.Background())
		}()
	}
	for i := 0; i < n; i++ {
		got := <-done
		require.Nil(t, got.Blog) // no last-good: zero response
	}
	require.Equal(t, int32(1), atomic.LoadInt32(&calls), "concurrent Gets must share one upstream fetch")

	// Within the negative TTL a failed refresh must not be retried.
	_ = svc.Get(context.Background())
	require.Equal(t, int32(1), atomic.LoadInt32(&calls), "Get within negative TTL must not hit upstream")
}

// TestNewsFailureNeverEvictsLastGood verifies that a failed refresh never
// clears the last-good response.
func TestNewsFailureNeverEvictsLastGood(t *testing.T) {
	var calls int32
	var fail atomic.Bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		if fail.Load() {
			w.WriteHeader(500)
			return
		}
		_, _ = w.Write([]byte(feedJSON))
	}))
	defer ts.Close()

	svc := New(&http.Client{Timeout: 5 * time.Second}, ts.URL, 20*time.Millisecond)
	r := svc.Get(context.Background()) // prime last-good
	require.NotNil(t, r.Blog)

	fail.Store(true)
	time.Sleep(30 * time.Millisecond) // stale

	_ = svc.Get(context.Background()) // triggers a refresh that fails

	// Wait until the failed refresh has actually completed.
	deadline := time.Now().Add(2 * time.Second)
	for atomic.LoadInt32(&calls) < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	require.GreaterOrEqual(t, atomic.LoadInt32(&calls), int32(2), "refresh attempt should have reached upstream")

	got := svc.Get(context.Background())
	require.NotNil(t, got.Blog, "failed refresh must not evict last-good")
	require.Equal(t, "Blog A", got.Blog.Title)
}

func TestWithUTM(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "diagrid host gets utm params",
			in:   "https://www.diagrid.io/blog/some-post",
			want: "https://www.diagrid.io/blog/some-post?utm_medium=menu&utm_source=dev-dashboard",
		},
		{
			name: "bare diagrid host gets utm params",
			in:   "https://diagrid.io/events/webinar",
			want: "https://diagrid.io/events/webinar?utm_medium=menu&utm_source=dev-dashboard",
		},
		{
			name: "non-diagrid host unchanged",
			in:   "https://example.com/article",
			want: "https://example.com/article",
		},
		{
			name: "existing query param preserved",
			in:   "https://www.diagrid.io/blog/post?ref=newsletter",
			want: "https://www.diagrid.io/blog/post?ref=newsletter&utm_medium=menu&utm_source=dev-dashboard",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := withUTM(tc.in)
			if got != tc.want {
				t.Fatalf("withUTM(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
