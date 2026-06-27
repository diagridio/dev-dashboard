//go:build unit

package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/stretchr/testify/require"
)

type fakeNews struct{ r news.Response }

func (f fakeNews) Get(context.Context) news.Response { return f.r }

func TestNewsEndpoint(t *testing.T) {
	h := newsRouter(fakeNews{r: news.Response{Blog: &news.Item{Title: "Hi", URL: "https://x"}}})
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"blog"`)
	require.Contains(t, body, `"title":"Hi"`)
}
