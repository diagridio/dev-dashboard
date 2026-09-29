//go:build unit

package secrets

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// writeStore lays down a local.file secret store YAML plus its JSON payload and
// returns a Service scanning that directory.
func writeStore(t *testing.T, storeYAML, secretsJSON string) (Service, string) {
	t.Helper()
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "store.yaml"), []byte(storeYAML), 0o600))
	if secretsJSON != "" {
		require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"), []byte(secretsJSON), 0o600))
	}
	return New(func() []string { return []string{dir} }), dir
}

const fileStoreDefaultYAML = `kind: Component
metadata:
  name: localsecretstore
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: secrets.json
`

func TestResolveFileFlatAndNestedKeys(t *testing.T) {
	svc, dir := writeStore(t, fileStoreDefaultYAML,
		`{"redisPassword":"flat","redis":{"password":"nested"},"blank":""}`)
	ctx := context.Background()

	// Flat top-level key.
	got := svc.Resolve(ctx, "localsecretstore", Ref{Kind: "secretKeyRef", Name: "redisPassword"})
	require.Equal(t, StatusResolved, got.Status)
	require.Equal(t, "flat", got.Value)

	// Nested key, flattened with the default ":" separator. This is the case
	// that silently failed before pkg/secrets existed.
	got = svc.Resolve(ctx, "localsecretstore", Ref{Kind: "secretKeyRef", Name: "redis:password"})
	require.Equal(t, StatusResolved, got.Status)
	require.Equal(t, "nested", got.Value)

	// The unflattened parent is NOT a key in non-multiValued mode.
	got = svc.Resolve(ctx, "localsecretstore", Ref{Kind: "secretKeyRef", Name: "redis"})
	require.Equal(t, StatusKeyNotFound, got.Status)

	// An empty value is not applied by the runtime, so it is its own status.
	got = svc.Resolve(ctx, "localsecretstore", Ref{Kind: "secretKeyRef", Name: "blank"})
	require.Equal(t, StatusEmptyValue, got.Status)

	// Detail names the file actually opened, so a wrong path is diagnosable.
	require.Contains(t, got.Detail, filepath.Join(dir, "secrets.json"))
}

func TestResolveFileCustomSeparator(t *testing.T) {
	const y = `kind: Component
metadata:
  name: s
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: secrets.json
  - name: nestedSeparator
    value: "|"
`
	svc, _ := writeStore(t, y, `{"redis":{"password":"nested"}}`)
	got := svc.Resolve(context.Background(), "s", Ref{Kind: "secretKeyRef", Name: "redis|password"})
	require.Equal(t, StatusResolved, got.Status)
	require.Equal(t, "nested", got.Value)
}

func TestResolveFileMultiValued(t *testing.T) {
	const y = `kind: Component
metadata:
  name: s
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: secrets.json
  - name: multiValued
    value: "true"
`
	svc, _ := writeStore(t, y, `{"redis":{"password":"nested"}}`)
	// With multiValued the parent IS the secret and the child is the key.
	got := svc.Resolve(context.Background(), "s", Ref{Kind: "secretKeyRef", Name: "redis", Key: "password"})
	require.Equal(t, StatusResolved, got.Status)
	require.Equal(t, "nested", got.Value)
}

func TestResolveFileMissingAndMalformed(t *testing.T) {
	ctx := context.Background()

	svc, dir := writeStore(t, fileStoreDefaultYAML, "") // no secrets.json
	got := svc.Resolve(ctx, "localsecretstore", Ref{Kind: "secretKeyRef", Name: "any"})
	require.Equal(t, StatusStoreUnreadable, got.Status)
	require.Contains(t, got.Detail, filepath.Join(dir, "secrets.json"))

	svc, _ = writeStore(t, fileStoreDefaultYAML, `{not json`)
	got = svc.Resolve(ctx, "localsecretstore", Ref{Kind: "secretKeyRef", Name: "any"})
	require.Equal(t, StatusStoreUnreadable, got.Status)
}

func TestResolveStoreStatuses(t *testing.T) {
	svc, _ := writeStore(t, fileStoreDefaultYAML, `{"a":"b"}`)
	ctx := context.Background()

	require.Equal(t, StatusStoreNotSpecified,
		svc.Resolve(ctx, "", Ref{Kind: "secretKeyRef", Name: "a"}).Status)
	require.Equal(t, StatusStoreNotFound,
		svc.Resolve(ctx, "nope", Ref{Kind: "secretKeyRef", Name: "a"}).Status)
}

func TestResolveUnsupportedStoreType(t *testing.T) {
	const y = `kind: Component
metadata:
  name: vault
spec:
  type: secretstores.hashicorp.vault
`
	svc, _ := writeStore(t, y, "")
	got := svc.Resolve(context.Background(), "vault", Ref{Kind: "secretKeyRef", Name: "a"})
	require.Equal(t, StatusStoreUnsupported, got.Status)
}

func TestResolvePicksUpFileEdits(t *testing.T) {
	svc, dir := writeStore(t, fileStoreDefaultYAML, `{"pw":"before"}`)
	ctx := context.Background()
	require.Equal(t, "before", svc.Resolve(ctx, "localsecretstore", Ref{Kind: "secretKeyRef", Name: "pw"}).Value)

	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"), []byte(`{"pw":"after-the-edit"}`), 0o600))
	require.Equal(t, "after-the-edit", svc.Resolve(ctx, "localsecretstore", Ref{Kind: "secretKeyRef", Name: "pw"}).Value,
		"cache must key on file size/mtime so an edit is picked up")
}
