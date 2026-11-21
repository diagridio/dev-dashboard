//go:build unit

package cmd

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/stretchr/testify/require"
)

func writeFeed(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "product-feed.json")
	require.NoError(t, os.WriteFile(p, []byte(body), 0o600))
	return p
}

const promoFeed = `{"promotion":{"id":"local-1","title":"T","url":"https://www.diagrid.io/x"}}`

func getPromotionID(t *testing.T, f newsFeed) string {
	t.Helper()
	r := news.New(f.Client, f.URL, f.TTL).Get(context.Background())
	require.NotNil(t, r.Promotion)
	return r.Promotion.ID
}

func TestResolveNewsFeedDefault(t *testing.T) {
	for _, raw := range []string{"", "   "} {
		f, err := resolveNewsFeed(raw)
		require.NoError(t, err)
		require.Equal(t, "https://www.diagrid.io/api/product-feed", f.URL)
		require.Equal(t, time.Hour, f.TTL)
		require.NotNil(t, f.Client)
		require.Empty(t, f.Notice)
	}
}

func TestResolveNewsFeedHTTPOverride(t *testing.T) {
	f, err := resolveNewsFeed("http://127.0.0.1:18765/product-feed.json")
	require.NoError(t, err)
	require.Equal(t, "http://127.0.0.1:18765/product-feed.json", f.URL)
	require.Equal(t, 5*time.Second, f.TTL)
	require.Contains(t, f.Notice, "DEVDASHBOARD_NEWS_FEED_URL")
	require.Contains(t, f.Notice, "http://127.0.0.1:18765/product-feed.json")
}

func TestResolveNewsFeedFilePath(t *testing.T) {
	p := writeFeed(t, promoFeed)

	t.Run("absolute path", func(t *testing.T) {
		f, err := resolveNewsFeed(p)
		require.NoError(t, err)
		require.Equal(t, 5*time.Second, f.TTL)
		require.Contains(t, f.Notice, p)
		require.Equal(t, "local-1", getPromotionID(t, f))
	})

	t.Run("file URL", func(t *testing.T) {
		f, err := resolveNewsFeed("file://" + filepath.ToSlash(p))
		require.NoError(t, err)
		require.Equal(t, "local-1", getPromotionID(t, f))
	})

	t.Run("relative path", func(t *testing.T) {
		wd, err := os.Getwd()
		require.NoError(t, err)
		rel, err := filepath.Rel(wd, p)
		require.NoError(t, err)
		f, err := resolveNewsFeed(rel)
		require.NoError(t, err)
		require.Equal(t, "local-1", getPromotionID(t, f))
	})

	t.Run("edits are picked up after the short TTL", func(t *testing.T) {
		p := writeFeed(t, promoFeed)
		f, err := resolveNewsFeed(p)
		require.NoError(t, err)
		f.TTL = 10 * time.Millisecond // same mechanism as the 5s override TTL, faster for the test
		svc := news.New(f.Client, f.URL, f.TTL)
		require.Equal(t, "local-1", svc.Get(context.Background()).Promotion.ID)

		require.NoError(t, os.WriteFile(p, []byte(`{"promotion":{"id":"local-2","title":"T","url":"https://www.diagrid.io/x"}}`), 0o600))
		time.Sleep(20 * time.Millisecond)
		require.Eventually(t, func() bool {
			r := svc.Get(context.Background())
			return r.Promotion != nil && r.Promotion.ID == "local-2"
		}, 2*time.Second, 10*time.Millisecond)
	})
}

func TestResolveNewsFeedInvalid(t *testing.T) {
	for _, raw := range []string{
		filepath.Join(t.TempDir(), "missing.json"),
		"ftp://example.test/feed",
		"https://",
	} {
		t.Run(raw, func(t *testing.T) {
			_, err := resolveNewsFeed(raw)
			require.Error(t, err)
			require.Contains(t, err.Error(), "DEVDASHBOARD_NEWS_FEED_URL")
		})
	}
}

// The fixture the testing guide points at must stay a valid feed with a promotion.
func TestPromotionFixtureFeed(t *testing.T) {
	f, err := resolveNewsFeed(filepath.Join("..", "test", "fixtures", "promotion", "product-feed.json"))
	require.NoError(t, err)
	require.Equal(t, "advent-of-workflow-local-test", getPromotionID(t, f))
}

func TestAssembleOptions_UsesConfiguredNewsFeed(t *testing.T) {
	f, err := resolveNewsFeed(writeFeed(t, promoFeed))
	require.NoError(t, err)
	opts, closers := assembleOptions(context.Background(), serveDeps{
		Namespace:  "default",
		Apps:       emptyApps{},
		HTTPClient: &http.Client{Timeout: time.Second},
		NewsFeed:   f,
	}, fstest.MapFS{})
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})
	r := opts.News.Get(context.Background())
	require.NotNil(t, r.Promotion)
	require.Equal(t, "local-1", r.Promotion.ID)
}
