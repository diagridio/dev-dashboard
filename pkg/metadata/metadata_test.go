//go:build unit

package metadata

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestInitAndServe(t *testing.T) {
	require.NoError(t, Init())

	req := httptest.NewRequest(http.MethodGet, "/metadata/components", nil)
	rec := httptest.NewRecorder()
	HandleGetComponents(rec, req)

	res := rec.Result()
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "application/json", res.Header.Get("Content-Type"))
	require.NotEmpty(t, res.Header.Get("ETag"))
	require.Contains(t, rec.Body.String(), `"type":"state"`)
}

func TestETagNotModified(t *testing.T) {
	require.NoError(t, Init())

	// First request to learn the ETag.
	rec1 := httptest.NewRecorder()
	HandleGetComponents(rec1, httptest.NewRequest(http.MethodGet, "/metadata/components", nil))
	etag := rec1.Result().Header.Get("ETag")
	require.NotEmpty(t, etag)

	// Conditional request with matching ETag → 304.
	req := httptest.NewRequest(http.MethodGet, "/metadata/components", nil)
	req.Header.Set("If-None-Match", etag)
	rec2 := httptest.NewRecorder()
	HandleGetComponents(rec2, req)
	require.Equal(t, http.StatusNotModified, rec2.Result().StatusCode)
}

func TestProcessingInvariants(t *testing.T) {
	require.NoError(t, Init())

	var b Bundle
	require.NoError(t, parseProcessed(&b))

	// No deprecated-status components survive.
	for _, c := range b.Components {
		require.NotEqual(t, "deprecated", c.Status)
	}
	// Sorted by type ascending.
	for i := 1; i < len(b.Components); i++ {
		require.LessOrEqual(t, b.Components[i-1].Type, b.Components[i].Type)
	}
	// At least one supported state store with its key field present.
	var foundRedisHost bool
	for _, c := range b.Components {
		if c.Type == "state" && c.Name == "redis" {
			for _, f := range c.Metadata {
				if f.Name == "redisHost" {
					foundRedisHost = true
				}
			}
		}
	}
	require.True(t, foundRedisHost, "state.redis should expose redisHost")
}
