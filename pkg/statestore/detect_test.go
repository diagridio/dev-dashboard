//go:build unit

package statestore

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

const redisComponent = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
    - name: redisHost
      value: localhost:6379
    - name: actorStateStore
      value: "true"
`

const pubsubComponent = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: pubsub
spec:
  type: pubsub.redis
  version: v1
`

const redisSecretRefComponent = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: secretstore-redis
spec:
  type: state.redis
  version: v1
  metadata:
    - name: redisHost
      value: localhost:6379
    - name: redisPassword
      secretKeyRef:
        name: redis-secret
        key: redis-password
auth:
  secretStore: local-secrets
`

func TestDetect(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "redis.yaml"), []byte(redisComponent), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "pubsub.yaml"), []byte(pubsubComponent), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("ignore me"), 0o600))

	got, err := Detect([]string{dir})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "statestore", got[0].Name)
	require.Equal(t, "state.redis", got[0].Type)
	require.Equal(t, "localhost:6379", got[0].Metadata["redisHost"])
	require.Equal(t, "true", got[0].Metadata["actorStateStore"])
}

func TestDetectParsesSecretKeyRef(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "redis.yaml"), []byte(redisSecretRefComponent), 0o600))

	comps, err := Detect([]string{dir})
	require.NoError(t, err)
	require.Len(t, comps, 1)
	c := comps[0]

	// Inline value retained.
	require.Equal(t, "localhost:6379", c.Metadata["redisHost"])
	// secretKeyRef entry is NOT added as an inline metadata value.
	_, hasInline := c.Metadata["redisPassword"]
	require.False(t, hasInline)
	// secretKeyRef + auth.secretStore captured.
	require.Equal(t, "local-secrets", c.SecretStore)
	ref, ok := c.SecretRefs["redisPassword"]
	require.True(t, ok)
	require.Equal(t, "redis-secret", ref.Name)
	require.Equal(t, "redis-password", ref.Key)
}
