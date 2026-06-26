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
