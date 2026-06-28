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
