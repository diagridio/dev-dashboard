//go:build unit

package discovery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestFetchMetadata(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"order","runtimeVersion":"1.14.4","extended":{"appPID":"48213","cliPID":"48201","appCommand":"go run ./cmd/order","appLogPath":"/l/app.log","daprdLogPath":"/l/daprd.log","runTemplateName":"dapr.yaml"}}`))
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())

	md, err := FetchMetadata(context.Background(), &http.Client{Timeout: 2 * time.Second}, port)
	require.NoError(t, err)
	require.Equal(t, "order", md.ID)
	require.Equal(t, "1.14.4", md.RuntimeVersion)
	require.Equal(t, 48213, md.AppPID)
	require.Equal(t, "go run ./cmd/order", md.AppCommand)
	require.Equal(t, "dapr.yaml", md.RunTemplate)
}
