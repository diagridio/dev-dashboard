//go:build integration

package discovery_test

import (
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/internal/golden"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

// update regenerates golden files: go test -tags integration ./pkg/discovery -run Golden -update
var update = flag.Bool("update", false, "regenerate golden files")

// TestFetchMetadataGolden pins the parsed Metadata struct produced from a
// captured /v1.0/metadata response, so a Dapr schema change surfaces as a diff.
func TestFetchMetadataGolden(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "metadata_response.json"))
	require.NoError(t, err)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1.0/metadata", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)

	u, err := url.Parse(srv.URL)
	require.NoError(t, err)
	port, err := strconv.Atoi(u.Port())
	require.NoError(t, err)

	md, err := discovery.FetchMetadata(context.Background(), &http.Client{Timeout: 2 * time.Second}, port)
	require.NoError(t, err)

	got, err := json.MarshalIndent(md, "", "  ")
	require.NoError(t, err)

	golden.Assert(t, *update, filepath.Join("testdata", "golden", "metadata_parsed.golden.json"), got)
}
