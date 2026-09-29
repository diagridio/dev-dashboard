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

const redisEnvRefComponent = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: envref-redis
spec:
  type: state.redis
  version: v1
  metadata:
    - name: redisHost
      value: localhost:6379
    - name: redisPassword
      envRef: REDIS_PASSWORD
`

const secondStateComponent = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore2
spec:
  type: state.in-memory
  version: v1
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

func TestDetectMultiDoc_StateStoreAfterOtherComponent(t *testing.T) {
	dir := t.TempDir()
	multi := pubsubComponent + "\n---\n" + redisComponent
	require.NoError(t, os.WriteFile(filepath.Join(dir, "resources.yaml"), []byte(multi), 0o600))

	got, err := Detect([]string{dir})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "statestore", got[0].Name)
	require.Equal(t, "state.redis", got[0].Type)
	require.Equal(t, "localhost:6379", got[0].Metadata["redisHost"])
}

func TestDetectMultiDoc_TwoStateStoresInOneFile(t *testing.T) {
	dir := t.TempDir()
	multi := redisComponent + "\n---\n" + secondStateComponent
	require.NoError(t, os.WriteFile(filepath.Join(dir, "resources.yaml"), []byte(multi), 0o600))

	got, err := Detect([]string{dir})
	require.NoError(t, err)
	require.Len(t, got, 2)

	byName := map[string]Component{}
	for _, c := range got {
		byName[c.Name] = c
	}
	require.Contains(t, byName, "statestore")
	require.Equal(t, "state.redis", byName["statestore"].Type)
	require.Contains(t, byName, "statestore2")
	require.Equal(t, "state.in-memory", byName["statestore2"].Type)
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
	require.Equal(t, "secretKeyRef", ref.Kind)
	require.Equal(t, "redis-secret", ref.Name)
	require.Equal(t, "redis-password", ref.Key)
}

// TestDetectParsesEnvRef covers finding 2 of the whole-branch review:
// pkg/statestore's own component parser used to only recognize secretKeyRef,
// so a state store declaring envRef fell through to an empty inline value
// with no SecretRefs entry at all — silently different from what
// pkg/secrets/pkg/resources reported for the very same YAML on the
// Components page.
func TestDetectParsesEnvRef(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "redis.yaml"), []byte(redisEnvRefComponent), 0o600))

	comps, err := Detect([]string{dir})
	require.NoError(t, err)
	require.Len(t, comps, 1)
	c := comps[0]

	require.Equal(t, "localhost:6379", c.Metadata["redisHost"])
	// envRef entry is NOT added as an inline metadata value (and must not be
	// an empty string either — that was the silent-failure symptom).
	_, hasInline := c.Metadata["redisPassword"]
	require.False(t, hasInline)

	ref, ok := c.SecretRefs["redisPassword"]
	require.True(t, ok, "envRef must populate SecretRefs, not fall through unnoticed")
	require.Equal(t, "envRef", ref.Kind)
	require.Equal(t, "REDIS_PASSWORD", ref.Name)
}
