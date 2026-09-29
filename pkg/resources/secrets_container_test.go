//go:build unit

package resources

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/stretchr/testify/require"
)

const containerStoreYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: containerstore
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: /dapr-resources/secrets.json
`

const containerRefYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  metadata:
  - name: redisPassword
    secretKeyRef:
      name: pw
auth:
  secretStore: containerstore
`

func TestContainerDeclaredStoreReportsUnreadable(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(containerRefYAML), 0o600))

	paths := func() []string { return []string{dir} }
	// The secret store exists only inside a container, surfaced via extras.
	extras := func() []Resource {
		return FromRaw("crazy_lamport:/dapr-resources", []byte(containerStoreYAML))
	}
	svc := New(paths, extras, WithSecrets(secrets.New(paths)))

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Len(t, got.SecretRefs, 1)
	require.Equal(t, string(secrets.StatusStoreUnreadable), got.SecretRefs[0].Status)
	require.Contains(t, got.SecretRefs[0].Detail, "crazy_lamport")
}

func TestGenuinelyMissingStoreStillReportsNotFound(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(containerRefYAML), 0o600))

	paths := func() []string { return []string{dir} }
	svc := New(paths, nil, WithSecrets(secrets.New(paths)))

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Len(t, got.SecretRefs, 1)
	require.Equal(t, string(secrets.StatusStoreNotFound), got.SecretRefs[0].Status)
}
