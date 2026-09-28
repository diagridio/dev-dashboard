//go:build unit

package secrets

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

const fileStoreYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: localsecretstore
spec:
  type: secretstores.local.file
  version: v1
  metadata:
  - name: secretsFile
    value: secrets.json
  - name: nestedSeparator
    value: "|"
`

const envStoreYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: envsecrets
spec:
  type: secretstores.local.env
  version: v1
  metadata:
  - name: prefix
    value: MYAPP_
`

const vaultStoreYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: vault
spec:
  type: secretstores.hashicorp.vault
  version: v1
`

func TestDetectStoresFindsLocalStores(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "file.yaml"), []byte(fileStoreYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "env.yaml"), []byte(envStoreYAML), 0o600))

	got := DetectStores([]string{dir})
	require.Len(t, got, 2)

	byName := map[string]Store{}
	for _, s := range got {
		byName[s.Name] = s
	}

	f := byName["localsecretstore"]
	require.Equal(t, "secretstores.local.file", f.Type)
	require.Equal(t, "secrets.json", f.Properties["secretsFile"])
	require.Equal(t, "|", f.Properties["nestedSeparator"])
	require.Equal(t, filepath.Join(dir, "file.yaml"), f.Path)

	e := byName["envsecrets"]
	require.Equal(t, "secretstores.local.env", e.Type)
	require.Equal(t, "MYAPP_", e.Properties["prefix"])
}

func TestDetectStoresIncludesUnsupportedTypes(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "vault.yaml"), []byte(vaultStoreYAML), 0o600))

	got := DetectStores([]string{dir})
	require.Len(t, got, 1)
	require.Equal(t, "secretstores.hashicorp.vault", got[0].Type)
	require.False(t, got[0].Supported())
}

func TestDetectStoresDedupesAndIgnoresNonYAML(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "file.yaml"), []byte(fileStoreYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "notes.txt"), []byte(fileStoreYAML), 0o600))

	// The same directory listed twice must not yield the store twice.
	got := DetectStores([]string{dir, dir})
	require.Len(t, got, 1)
}
