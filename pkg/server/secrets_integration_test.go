//go:build integration

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/stretchr/testify/require"
)

// noAppsDiscovery is a minimal discovery.Service stub reporting no running
// app instances. The resources list endpoint always consults Apps to fill in
// LoadedBy, so the router needs one even though this test does not exercise
// app discovery. The real fakeApps helper lives in a "unit"-tagged file and
// is invisible to this "integration"-tagged one, hence this inline stand-in.
type noAppsDiscovery struct{}

func (noAppsDiscovery) List(context.Context) ([]discovery.Instance, error) { return nil, nil }
func (noAppsDiscovery) Get(context.Context, string) (discovery.Instance, error) {
	return discovery.Instance{}, discovery.ErrNotFound
}

// TestSecretReferencesEndToEnd exercises the real assembled router (no
// mocks) over a component whose secretKeyRef is backed by a local.file
// secret store: the resources list must report resolution status without
// ever leaking the secret value, and the dedicated reveal endpoint must be
// the only path that returns it.
func TestSecretReferencesEndToEnd(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secretstore.yaml"), []byte(`apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: localsecretstore
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: secrets.json
`), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(`apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  metadata:
  - name: redisPassword
    secretKeyRef:
      name: redis:password
auth:
  secretStore: localsecretstore
`), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"),
		[]byte(`{"redis":{"password":"s3cr3t"}}`), 0o600))

	paths := func() []string { return []string{dir} }
	res := resources.New(paths, nil, resources.WithSecrets(secrets.New(paths)))
	h := NewRouter(Options{
		DistFS:     fstest.MapFS{"index.html": {Data: []byte("shell")}},
		Resources:  res,
		Apps:       noAppsDiscovery{},
		ListenPort: 9090,
	})

	// The list reports status and leaks nothing.
	req := httptest.NewRequest(http.MethodGet, "/api/resources?kind=component", nil)
	req.Host = "127.0.0.1:9090"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"status":"resolved"`)
	require.NotContains(t, rec.Body.String(), "s3cr3t")

	var list []resources.Resource
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &list))
	var id string
	for _, r := range list {
		if r.Name == "statestore" {
			id = r.ID
		}
	}
	require.NotEmpty(t, id)

	// The reveal endpoint is the only path that returns the value.
	req = httptest.NewRequest(http.MethodPost,
		"/api/resources/component/"+id+"/secret-value", strings.NewReader(`{"field":"redisPassword"}`))
	req.Host = "127.0.0.1:9090"
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "s3cr3t")
}
