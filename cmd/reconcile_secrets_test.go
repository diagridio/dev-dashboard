//go:build unit

package cmd

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestReconcileResolvesSecretsOnFirstPass is a regression test for the boot-
// pass ordering bug: rc.secretsSvc closes over rc.Paths, which reads the
// mutable rc.resPaths field. If rc.resPaths is not published before the
// detect/resolve loop runs inside reconcile, the very first (synchronous
// boot-seed) reconcile sees rc.resPaths == nil, secret detection finds zero
// stores, and every secretKeyRef resolves to store-not-found — forever, on a
// stable dev session, since maybeReconcile only re-runs on an apps
// fingerprint change.
//
// This test builds a real reconciler via newReconciler (no fakes standing in
// for the paths->secrets wiring), calls rc.reconcile exactly once — mirroring
// the synchronous boot seed in cmd/serve.go — and asserts the secretKeyRef in
// the elected active component was actually resolved from that single call.
func TestReconcileResolvesSecretsOnFirstPass(t *testing.T) {
	home := t.TempDir()
	compDir := filepath.Join(home, ".dapr", "components")
	require.NoError(t, os.MkdirAll(compDir, 0o755))

	secretStoreYAML := `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: localsecrets
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: secrets.json
`
	require.NoError(t, os.WriteFile(filepath.Join(compDir, "secretstore.yaml"), []byte(secretStoreYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(compDir, "secrets.json"), []byte(`{"redis-secret":"s3cr3t"}`), 0o600))

	stateStoreYAML := `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  metadata:
  - name: redisHost
    value: localhost:6379
  - name: redisPassword
    secretKeyRef:
      name: redis-secret
auth:
  secretStore: localsecrets
`
	require.NoError(t, os.WriteFile(filepath.Join(compDir, "statestore.yaml"), []byte(stateStoreYAML), 0o600))

	rc := newReconciler(context.Background(), nil, "default", home, "", nil, nil, nil, nil, nil)
	t.Cleanup(func() { _ = rc.Close() })

	// A single synchronous reconcile pass — exactly what cmd/serve.go's boot
	// seed does before the server starts serving requests.
	rc.reconcile(nil, "fp1")

	active := rc.activeComponent()
	require.NotNil(t, active, "a single detected state store must be elected active")
	require.Equal(t, "localhost:6379", active.Metadata["redisHost"])
	require.Equal(t, "s3cr3t", active.Metadata["redisPassword"],
		"the secretKeyRef must resolve on the very first reconcile call, not only after a second pass")
}
