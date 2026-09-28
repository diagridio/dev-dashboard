//go:build unit

package cmd

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// writeFixtureStore lays down a local.file secret store (secretstore.yaml)
// plus its secrets.json payload ({"redis":{"password":"v"}}) in dir, so tests
// can resolve "redis:password" via the ":"-flattened nested-key convention.
func writeFixtureStore(t *testing.T, dir string) {
	t.Helper()
	secretStoreYAML := `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: localsecretstore
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: secrets.json
`
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secretstore.yaml"), []byte(secretStoreYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"), []byte(`{"redis":{"password":"v"}}`), 0o600))
}

func TestResolveComponentSecretsReportsFirstIssue(t *testing.T) {
	dir := t.TempDir()
	writeFixtureStore(t, dir)
	svc := secrets.New(func() []string { return []string{dir} })

	c := statestore.Component{
		Name: "statestore", Type: "state.redis", SecretStore: "localsecretstore",
		Metadata: map[string]string{"redisHost": "localhost:6379"},
		SecretRefs: map[string]statestore.SecretRef{
			"redisPassword": {Name: "redis:password"},
			"aMissingField": {Name: "absent"},
		},
	}

	resolved, issue := resolveComponentSecrets(svc, c)
	require.Equal(t, "v", resolved["redisPassword"], "resolvable refs still apply")
	require.Contains(t, issue, "aMissingField")
	require.Contains(t, issue, "key-not-found")
}

func TestResolveComponentSecretsCleanWhenAllResolve(t *testing.T) {
	dir := t.TempDir()
	writeFixtureStore(t, dir)
	svc := secrets.New(func() []string { return []string{dir} })

	c := statestore.Component{
		Name: "statestore", Type: "state.redis", SecretStore: "localsecretstore",
		SecretRefs: map[string]statestore.SecretRef{"redisPassword": {Name: "redis:password"}},
	}
	_, issue := resolveComponentSecrets(svc, c)
	require.Empty(t, issue)
}

// TestReconciler_StoresReportsSecretIssue covers the seam Task 9 actually
// adds: rc.Stores() must thread componentForEntry's second return (the
// resolveComponentSecrets issue sentence) into StoreInfo.SecretIssue for an
// AUTO entry read straight off disk — not just resolveComponentSecrets in
// isolation (that's Task 6's own coverage). A dropped or swapped issue value
// in the StoreInfo{} literal in Stores() would pass every other Go test in
// this package but must fail this one.
func TestReconciler_StoresReportsSecretIssue(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	// An auto entry whose secretKeyRef cannot resolve: its auth.secretStore
	// names a store that does not exist on disk anywhere under home/dir, so
	// resolution fails deterministically (store-not-found) regardless of
	// which secrets.json fixtures happen to be present.
	issueYAML := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: brokenstore\n" +
		"spec:\n  type: state.redis\n  version: v1\n  metadata:\n" +
		"  - name: redisHost\n    value: localhost:6379\n" +
		"  - name: redisPassword\n    secretKeyRef:\n      name: redis-secret\n" +
		"auth:\n  secretStore: missing-secrets\n"
	issuePath := filepath.Join(dir, "brokenstore.yaml")
	require.NoError(t, os.WriteFile(issuePath, []byte(issueYAML), 0o644))
	issueAbs, err := filepath.Abs(issuePath)
	require.NoError(t, err)

	// A second auto entry with no secret refs at all, so the test also
	// catches a spurious/stale issue leaking onto an unrelated store.
	cleanPath := seedAutoComponentYAML(t, dir, "cleanstore", filepath.Join(dir, "clean.db"))

	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "brokenstore", Type: "state.redis", Source: SourceAuto, Path: issueAbs}))
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "cleanstore", Type: "state.sqlite", Source: SourceAuto, Path: cleanPath}))

	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open, nil)
	rc := newReconciler(context.Background(), nil, "default", home, "", &http.Client{}, reg, pool, nil, nil)
	t.Cleanup(func() { _ = rc.Close() })

	infos := rc.Stores()
	byName := map[string]server.StoreInfo{}
	for _, i := range infos {
		byName[i.Name] = i
	}
	require.Contains(t, byName, "brokenstore")
	require.Contains(t, byName, "cleanstore")

	issue := byName["brokenstore"].SecretIssue
	require.Contains(t, issue, "redisPassword", "the StoreInfo returned by Stores() must name the unresolved field")
	require.Contains(t, issue, "store-not-found", "the StoreInfo returned by Stores() must name the resolution status")

	require.Empty(t, byName["cleanstore"].SecretIssue,
		"an entry with no unresolved refs must not carry a stale/spurious SecretIssue")
}
