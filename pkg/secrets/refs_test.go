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

// An HTTPEndpoint keeps its references in spec.headers, resolved from the same
// auth.secretStore; a header's name is its field. A non-string plain value
// must not stop the references from being read.
func TestParseRefsHTTPEndpointHeaders(t *testing.T) {
	const endpoint = `apiVersion: dapr.io/v1alpha1
kind: HTTPEndpoint
metadata:
  name: identity-api
spec:
  baseUrl: http://localhost:8091
  headers:
  - name: Accept-Language
    value: en-US
  - name: X-Retries
    value: 3
  - name: Authorization
    secretKeyRef:
      name: iam-token
      key: token
  - name: X-Tenant
    envRef: TENANT_ID
auth:
  secretStore: localsecrets
`
	store, refs := ParseRefs([]byte(endpoint))

	require.Equal(t, "localsecrets", store)
	require.Equal(t, map[string]Ref{
		"Authorization": {Kind: "secretKeyRef", Name: "iam-token", Key: "token"},
		"X-Tenant":      {Kind: "envRef", Name: "TENANT_ID"},
	}, refs)
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
