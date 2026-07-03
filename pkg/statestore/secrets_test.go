//go:build unit

package statestore

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

const localFileSecretStore = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: local-secrets
spec:
  type: secretstores.local.file
  version: v1
  metadata:
    - name: secretsFile
      value: secrets.json
`

const localEnvSecretStore = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: env-secrets
spec:
  type: secretstores.local.env
  version: v1
`

const k8sSecretStore = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: k8s-secrets
spec:
  type: secretstores.kubernetes
  version: v1
`

func TestDetectSecretStores(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "file.yaml"), []byte(localFileSecretStore), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "env.yaml"), []byte(localEnvSecretStore), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "k8s.yaml"), []byte(k8sSecretStore), 0o600))

	stores, err := DetectSecretStores([]string{dir})
	require.NoError(t, err)

	byName := map[string]SecretStore{}
	for _, s := range stores {
		byName[s.Name] = s
	}
	require.Contains(t, byName, "local-secrets")
	require.Contains(t, byName, "env-secrets")
	require.NotContains(t, byName, "k8s-secrets") // unsupported type ignored

	fs := byName["local-secrets"]
	require.Equal(t, "secretstores.local.file", fs.Type)
	require.Equal(t, filepath.Join(dir, "secrets.json"), fs.SecretsFile) // relative resolved against component dir
	require.Equal(t, ":", fs.NestedSeparator)
}

func TestDetectSecretStoresMultiDoc_StoreAfterOtherComponent(t *testing.T) {
	dir := t.TempDir()
	multi := k8sSecretStore + "\n---\n" + localFileSecretStore + "\n---\n" + localEnvSecretStore
	require.NoError(t, os.WriteFile(filepath.Join(dir, "resources.yaml"), []byte(multi), 0o600))

	stores, err := DetectSecretStores([]string{dir})
	require.NoError(t, err)

	byName := map[string]SecretStore{}
	for _, s := range stores {
		byName[s.Name] = s
	}
	require.Contains(t, byName, "local-secrets")
	require.Contains(t, byName, "env-secrets")
	require.NotContains(t, byName, "k8s-secrets")

	fs := byName["local-secrets"]
	require.Equal(t, "secretstores.local.file", fs.Type)
	require.Equal(t, filepath.Join(dir, "secrets.json"), fs.SecretsFile)
}

func TestResolveSecrets_LocalFileNested(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"),
		[]byte(`{"redis-secret":{"redis-password":"s3cr3t"}}`), 0o600))
	stores := []SecretStore{{Name: "local-secrets", Type: "secretstores.local.file",
		SecretsFile: filepath.Join(dir, "secrets.json"), NestedSeparator: ":"}}
	c := Component{
		Metadata:    map[string]string{"redisHost": "localhost:6379"},
		SecretRefs:  map[string]SecretRef{"redisPassword": {Name: "redis-secret", Key: "redis-password"}},
		SecretStore: "local-secrets",
	}

	md, unresolved := ResolveSecrets(c, stores)
	require.Empty(t, unresolved)
	require.Equal(t, "localhost:6379", md["redisHost"])
	require.Equal(t, "s3cr3t", md["redisPassword"])
}

func TestResolveSecrets_LocalFileString(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"),
		[]byte(`{"redis-secret":"flatpw"}`), 0o600))
	stores := []SecretStore{{Name: "local-secrets", Type: "secretstores.local.file",
		SecretsFile: filepath.Join(dir, "secrets.json"), NestedSeparator: ":"}}
	c := Component{
		SecretRefs:  map[string]SecretRef{"redisPassword": {Name: "redis-secret", Key: "redis-password"}},
		SecretStore: "local-secrets",
	}

	md, unresolved := ResolveSecrets(c, stores)
	require.Empty(t, unresolved)
	require.Equal(t, "flatpw", md["redisPassword"])
}

func TestResolveSecrets_LocalEnv(t *testing.T) {
	t.Setenv("REDIS_PW", "envpw")
	stores := []SecretStore{{Name: "env-secrets", Type: "secretstores.local.env"}}
	c := Component{
		SecretRefs:  map[string]SecretRef{"redisPassword": {Name: "REDIS_PW", Key: "REDIS_PW"}},
		SecretStore: "env-secrets",
	}

	md, unresolved := ResolveSecrets(c, stores)
	require.Empty(t, unresolved)
	require.Equal(t, "envpw", md["redisPassword"])
}

func TestResolveSecrets_LocalEnv_KeyFallback(t *testing.T) {
	t.Setenv("REDIS_PW", "envpw")
	stores := []SecretStore{{Name: "env-secrets", Type: "secretstores.local.env"}}
	c := Component{
		SecretRefs:  map[string]SecretRef{"redisPassword": {Name: "REDIS_PW", Key: ""}},
		SecretStore: "env-secrets",
	}
	md, unresolved := ResolveSecrets(c, stores)
	require.Empty(t, unresolved)
	require.Equal(t, "envpw", md["redisPassword"])
}

func TestResolveSecrets_Unresolvable(t *testing.T) {
	// No matching secret store at all.
	c := Component{
		SecretRefs:  map[string]SecretRef{"redisPassword": {Name: "redis-secret", Key: "redis-password"}},
		SecretStore: "missing-store",
	}
	md, unresolved := ResolveSecrets(c, nil)
	require.Equal(t, []string{"redisPassword"}, unresolved)
	_, has := md["redisPassword"]
	require.False(t, has)
}

func TestResolveSecrets_InlineOnlyUnchanged(t *testing.T) {
	c := Component{Metadata: map[string]string{"redisHost": "localhost:6379"}}
	md, unresolved := ResolveSecrets(c, nil)
	require.Empty(t, unresolved)
	require.Equal(t, map[string]string{"redisHost": "localhost:6379"}, md)
}
