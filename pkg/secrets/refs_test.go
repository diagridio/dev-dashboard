//go:build unit

package secrets

import (
	"testing"

	"github.com/stretchr/testify/require"
)

const refComponentYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: localhost:6379
  - name: redisPassword
    secretKeyRef:
      name: redis:password
  - name: redisUser
    secretKeyRef:
      name: creds
      key: user
  - name: apiToken
    envRef: MY_TOKEN
auth:
  secretStore: localsecretstore
`

func TestParseRefs(t *testing.T) {
	store, refs := ParseRefs([]byte(refComponentYAML))

	require.Equal(t, "localsecretstore", store)
	require.Len(t, refs, 3)
	require.NotContains(t, refs, "redisHost", "plain values are not references")

	require.Equal(t, Ref{Kind: "secretKeyRef", Name: "redis:password"}, refs["redisPassword"])
	require.Equal(t, "redis:password", refs["redisPassword"].EffectiveKey(), "key falls back to name")

	require.Equal(t, Ref{Kind: "secretKeyRef", Name: "creds", Key: "user"}, refs["redisUser"])
	require.Equal(t, "user", refs["redisUser"].EffectiveKey())

	require.Equal(t, Ref{Kind: "envRef", Name: "MY_TOKEN"}, refs["apiToken"])
}

func TestParseRefsNoRefs(t *testing.T) {
	const plain = `kind: Component
metadata:
  name: c
spec:
  type: state.redis
  metadata:
  - name: redisHost
    value: localhost:6379
`
	store, refs := ParseRefs([]byte(plain))
	require.Equal(t, "", store)
	require.Empty(t, refs)
}
