# Secret Resolution (Spec 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve Dapr `secretKeyRef` metadata (via `secretstores.local.file` / `secretstores.local.env`) when connecting a state store, so secret-backed components connect — fixing the active store today.

**Architecture:** Extend `pkg/statestore` component parsing to capture `secretKeyRef` + `auth.secretStore`; add a `DetectSecretStores` scanner and a pure `ResolveSecrets` function; in the reconciler, resolve each detected store's metadata before `statestore.New`. Inline-only components are unchanged; unresolvable refs degrade gracefully.

**Tech Stack:** Go (`sigs.k8s.io/yaml`, `encoding/json`, components-contrib sqlite for the integration test, testify).

## Global Constraints

- **Build tags:** new/changed Go test files start with `//go:build unit` (unit) or `//go:build integration`. Unit: `go test -tags unit ./...`; integration: `go test -tags integration ./cmd/...`. A bare `go test ./...` finds no tests in `pkg/statestore`/`cmd`.
- **Commit hygiene:** commit ONLY the task's files via explicit `git add <paths>`; never `git commit -am`. Leave the pre-existing uncommitted artifacts `web/dist/index.html`, `web/package-lock.json`, and `web/src/styles/theme.css` untouched.
- **Supported secret stores:** only `secretstores.local.file` and `secretstores.local.env`. Any other type (incl. `secretstores.kubernetes`) is treated as unsupported → left unresolved, never an error.
- **Graceful degradation:** unsupported types, missing stores, unreadable files, and missing secrets never crash — the affected metadata key is left unset and reported as unresolved.
- **Component key shapes:** `auth.secretStore` is a top-level component field (sibling of `spec`). `local.file` secrets JSON is either a string (`{"name":"val"}`) or a nested object (`{"name":{"key":"val"}}`).

---

### Task 1: Parse `secretKeyRef` + `auth.secretStore` into `Component`

**Files:**
- Modify: `pkg/statestore/store.go` (the `Component` struct)
- Modify: `pkg/statestore/detect.go` (`rawComponent` + `Detect`)
- Test: `pkg/statestore/detect_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type SecretRef struct { Name string; Key string }`; `Component` gains `SecretRefs map[string]SecretRef` and `SecretStore string`. `Detect` populates them.

- [ ] **Step 1: Write the failing test**

Append to `pkg/statestore/detect_test.go`:

```go
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./pkg/statestore/ -run TestDetectParsesSecretKeyRef -v`
Expected: FAIL to compile — `c.SecretStore` / `c.SecretRefs` undefined.

- [ ] **Step 3: Extend the `Component` struct**

In `pkg/statestore/store.go`, replace the `Component` struct with:

```go
// SecretRef is a Dapr secretKeyRef: the secret name and the key within it.
type SecretRef struct {
	Name string // secretKeyRef.name (the secret's name)
	Key  string // secretKeyRef.key (the key within that secret)
}

// Component is the parsed subset of a Dapr state-store component YAML we need.
type Component struct {
	Name        string               // metadata.name
	Type        string               // spec.type, e.g. "state.redis"
	Version     string               // spec.version
	Metadata    map[string]string    // spec.metadata name->value (inline only)
	SecretRefs  map[string]SecretRef // spec.metadata name->secretKeyRef (no inline value)
	SecretStore string               // auth.secretStore
	Path        string               // source file path (for display / disambiguation)
}
```

(If `Component` already has a doc comment above it, keep it; only the fields and the new `SecretRef` type are added.)

- [ ] **Step 4: Extend parsing in `detect.go`**

In `pkg/statestore/detect.go`, replace `rawComponent` with:

```go
type rawComponent struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Type     string `json:"type"`
		Version  string `json:"version"`
		Metadata []struct {
			Name         string `json:"name"`
			Value        string `json:"value"`
			SecretKeyRef struct {
				Name string `json:"name"`
				Key  string `json:"key"`
			} `json:"secretKeyRef"`
		} `json:"metadata"`
	} `json:"spec"`
	Auth struct {
		SecretStore string `json:"secretStore"`
	} `json:"auth"`
}
```

Then in `Detect`, replace the metadata-map construction + the `out = append(...)` block with:

```go
			md := make(map[string]string, len(rc.Spec.Metadata))
			var refs map[string]SecretRef
			for _, m := range rc.Spec.Metadata {
				if m.SecretKeyRef.Name != "" {
					if refs == nil {
						refs = make(map[string]SecretRef)
					}
					refs[m.Name] = SecretRef{Name: m.SecretKeyRef.Name, Key: m.SecretKeyRef.Key}
					continue
				}
				md[m.Name] = m.Value
			}
			absPath, err := filepath.Abs(path)
			if err != nil {
				absPath = path
			}
			if seen[absPath] {
				return nil
			}
			seen[absPath] = true
			out = append(out, Component{
				Name: rc.Metadata.Name, Type: rc.Spec.Type, Version: rc.Spec.Version,
				Metadata: md, SecretRefs: refs, SecretStore: rc.Auth.SecretStore, Path: absPath,
			})
			return nil
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `go test -tags unit ./pkg/statestore/ -v`
Expected: PASS — new `TestDetectParsesSecretKeyRef` plus existing `TestDetect`/`TestPatterns`/`TestParseInstanceID`/conninfo tests (inline-only components still parse into `Metadata`).

- [ ] **Step 6: Commit**

```bash
git add pkg/statestore/store.go pkg/statestore/detect.go pkg/statestore/detect_test.go
git commit -m "feat(statestore): parse secretKeyRef and auth.secretStore into Component"
```

---

### Task 2: `DetectSecretStores` + `ResolveSecrets`

**Files:**
- Create: `pkg/statestore/secrets.go`
- Test: `pkg/statestore/secrets_test.go`

**Interfaces:**
- Consumes: `Component`, `SecretRef` (Task 1).
- Produces:
  - `type SecretStore struct { Name string; Type string; SecretsFile string; NestedSeparator string }`
  - `func DetectSecretStores(paths []string) ([]SecretStore, error)`
  - `func ResolveSecrets(c Component, stores []SecretStore) (map[string]string, []string)` — returns resolved metadata + unresolved metadata-key names.

- [ ] **Step 1: Write the failing tests**

Create `pkg/statestore/secrets_test.go`:

```go
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test -tags unit ./pkg/statestore/ -run 'TestDetectSecretStores|TestResolveSecrets' -v`
Expected: FAIL to compile — `DetectSecretStores` / `ResolveSecrets` / `SecretStore` undefined.

- [ ] **Step 3: Implement `secrets.go`**

Create `pkg/statestore/secrets.go`:

```go
package statestore

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"sigs.k8s.io/yaml"
)

// SecretStore is a detected local Dapr secret-store component. Only the two
// local dev types are represented: secretstores.local.file and
// secretstores.local.env.
type SecretStore struct {
	Name            string
	Type            string // "secretstores.local.file" | "secretstores.local.env"
	SecretsFile     string // local.file only: resolved absolute path to the JSON file
	NestedSeparator string // local.file only: default ":"
}

type rawSecretStore struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Type     string `json:"type"`
		Metadata []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"metadata"`
	} `json:"spec"`
}

// DetectSecretStores finds local secret-store components (local.file / local.env)
// under the given files or directories. Other secret-store types are ignored.
func DetectSecretStores(paths []string) ([]SecretStore, error) {
	var out []SecretStore
	seen := map[string]bool{}
	for _, p := range paths {
		_ = filepath.Walk(p, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if ext != ".yaml" && ext != ".yml" {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			var rc rawSecretStore
			if err := yaml.Unmarshal(data, &rc); err != nil {
				return nil
			}
			if rc.Kind != "Component" || !strings.HasPrefix(rc.Spec.Type, "secretstores.local.") {
				return nil
			}
			absPath, err := filepath.Abs(path)
			if err != nil {
				absPath = path
			}
			if seen[absPath] {
				return nil
			}
			seen[absPath] = true

			s := SecretStore{Name: rc.Metadata.Name, Type: rc.Spec.Type, NestedSeparator: ":"}
			for _, m := range rc.Spec.Metadata {
				switch m.Name {
				case "secretsFile":
					sf := m.Value
					if sf != "" && !filepath.IsAbs(sf) {
						sf = filepath.Join(filepath.Dir(absPath), sf)
					}
					s.SecretsFile = sf
				case "nestedSeparator":
					if m.Value != "" {
						s.NestedSeparator = m.Value
					}
				}
			}
			out = append(out, s)
			return nil
		})
	}
	return out, nil
}

// ResolveSecrets returns a copy of c.Metadata with each secretKeyRef entry
// resolved using the secret store named by c.SecretStore. Metadata keys that
// cannot be resolved are returned in unresolved and left out of the map.
func ResolveSecrets(c Component, stores []SecretStore) (resolved map[string]string, unresolved []string) {
	out := make(map[string]string, len(c.Metadata)+len(c.SecretRefs))
	for k, v := range c.Metadata {
		out[k] = v
	}
	if len(c.SecretRefs) == 0 {
		return out, nil
	}
	var store *SecretStore
	for i := range stores {
		if stores[i].Name == c.SecretStore {
			store = &stores[i]
			break
		}
	}
	for metaName, ref := range c.SecretRefs {
		val, ok := resolveOne(store, ref)
		if !ok {
			unresolved = append(unresolved, metaName)
			continue
		}
		out[metaName] = val
	}
	return out, unresolved
}

func resolveOne(store *SecretStore, ref SecretRef) (string, bool) {
	if store == nil {
		return "", false
	}
	switch store.Type {
	case "secretstores.local.env":
		key := ref.Key
		if key == "" {
			key = ref.Name
		}
		v := os.Getenv(key)
		return v, v != ""
	case "secretstores.local.file":
		return resolveFromFile(store.SecretsFile, ref)
	default:
		return "", false
	}
}

func resolveFromFile(file string, ref SecretRef) (string, bool) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", false
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return "", false
	}
	raw, ok := doc[ref.Name]
	if !ok {
		return "", false
	}
	// String form: {"redis-secret":"value"}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s, true
	}
	// Nested form: {"redis-secret":{"redis-password":"value"}}
	var nested map[string]string
	if err := json.Unmarshal(raw, &nested); err == nil {
		key := ref.Key
		if key == "" {
			key = ref.Name
		}
		if v, ok := nested[key]; ok {
			return v, true
		}
	}
	return "", false
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test -tags unit ./pkg/statestore/ -v`
Expected: PASS — all six new secret tests plus the existing suite.

- [ ] **Step 5: Commit**

```bash
git add pkg/statestore/secrets.go pkg/statestore/secrets_test.go
git commit -m "feat(statestore): detect local secret stores and resolve secretKeyRef"
```

---

### Task 3: Resolve secrets in the reconciler + end-to-end integration test

**Files:**
- Modify: `cmd/reconciler.go` (in `reconcile`, after `Detect`)
- Test: `cmd/secret_resolution_integration_test.go` (create)

**Interfaces:**
- Consumes: `statestore.DetectSecretStores`, `statestore.ResolveSecrets` (Task 2); the existing `statestore.Detect`, `assembleOptions`, `server.NewRouter`, `statestore.New`, `statestore.SeedForTest`, `statestore.InstancePrefix`/`SuffixMetadata`/`HistoryPrefix`.
- Produces: nothing later tasks rely on (final task).

- [ ] **Step 1: Write the failing integration test**

Create `cmd/secret_resolution_integration_test.go`. It mirrors the existing `cmd/serve_integration_test.go` but supplies the SQLite `connectionString` via a `secretKeyRef` resolved from a `local.file` secret store, and reaches the store through a running app's resource path (so the secret-store YAML is in scan scope):

```go
//go:build integration

package cmd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestAssembleResolvesSecretKeyRefAndServesWorkflow(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "wf.db")

	// Seed one workflow instance into the SQLite store (inline connectionString).
	store, err := statestore.New(context.Background(), statestore.Component{
		Name: "statestore", Type: "state.sqlite", Version: "v1",
		Metadata: map[string]string{"connectionString": dbPath},
	})
	require.NoError(t, err)
	started := &protos.HistoryEvent{
		EventId:   0,
		Timestamp: timestamppb.New(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)),
		EventType: &protos.HistoryEvent_ExecutionStarted{
			ExecutionStarted: &protos.ExecutionStartedEvent{Name: "OrderWorkflow"},
		},
	}
	b, err := proto.Marshal(started)
	require.NoError(t, err)
	prefix := statestore.InstancePrefix("default", "order", "inst-1")
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.SuffixMetadata, []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.HistoryPrefix+"000000", b))
	require.NoError(t, store.Close())

	// secrets.json holds the connection string.
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"),
		[]byte(`{"sqlite-secret":{"conn":"`+dbPath+`"}}`), 0o600))

	// local.file secret store component.
	secretComp := "apiVersion: dapr.io/v1alpha1\nkind: Component\n" +
		"metadata:\n  name: local-secrets\n" +
		"spec:\n  type: secretstores.local.file\n  version: v1\n  metadata:\n" +
		"  - name: secretsFile\n    value: secrets.json\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets-store.yaml"), []byte(secretComp), 0o644))

	// State-store component: connectionString via secretKeyRef.
	stateComp := "apiVersion: dapr.io/v1alpha1\nkind: Component\n" +
		"metadata:\n  name: statestore\n" +
		"spec:\n  type: state.sqlite\n  version: v1\n  metadata:\n" +
		"  - name: connectionString\n    secretKeyRef:\n      name: sqlite-secret\n      key: conn\n" +
		"auth:\n  secretStore: local-secrets\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(stateComp), 0o644))

	dist := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")}}

	// No StateStorePath override: the running app's ResourcePaths put `dir` in
	// scan scope so BOTH the state store and the secret store are detected.
	opts, closers := assembleOptions(context.Background(), serveDeps{
		Namespace: "default",
		Apps: wiringFakeApps{insts: []discovery.Instance{
			{AppID: "order", HTTPPort: 3500, Health: discovery.HealthHealthy, ResourcePaths: []string{dir}},
		}},
		HomeDir:    t.TempDir(), // empty: don't scan the real ~/.dapr
		HTTPClient: &http.Client{Timeout: 2 * time.Second},
	}, dist)
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	srv := httptest.NewServer(server.NewRouter(opts))
	t.Cleanup(srv.Close)

	// The secretKeyRef connectionString resolved → store connected → the seeded
	// instance is returned through the real read path.
	res, body := httpGet(t, srv.URL+"/api/workflows")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"inst-1"`)
}
```

(`wiringFakeApps` and `httpGet` already exist in `cmd/serve_integration_test.go`, same `package cmd` + `//go:build integration`, so they are in scope.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags integration ./cmd/ -run TestAssembleResolvesSecretKeyRefAndServesWorkflow -v`
Expected: FAIL — the SQLite store's `connectionString` is empty (secretKeyRef not resolved yet), so the store doesn't open / `/api/workflows` does not contain `inst-1`.

- [ ] **Step 3: Wire resolution into the reconciler**

In `cmd/reconciler.go`, inside `reconcile`, replace the line:

```go
	detected, _ := statestore.Detect(scanPaths)
```

with:

```go
	detected, _ := statestore.Detect(scanPaths)
	secretStores, _ := statestore.DetectSecretStores(scanPaths)
	for i := range detected {
		resolved, unresolved := statestore.ResolveSecrets(detected[i], secretStores)
		detected[i].Metadata = resolved
		if len(unresolved) > 0 {
			log.Warn("unresolved secretKeyRef metadata", "store", detected[i].Name, "keys", unresolved)
		}
	}
```

(`log` is the `slog.Default().With("component", "reconciler")` already declared at the top of `reconcile`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags integration ./cmd/ -run TestAssembleResolvesSecretKeyRefAndServesWorkflow -v`
Expected: PASS — `/api/workflows` contains `"instanceId":"inst-1"`.

- [ ] **Step 5: Run the full suites to confirm no regressions**

Run: `go build ./...`
Expected: success.
Run: `go test -tags unit -race ./...` then `go test -tags integration -race ./cmd/...`
Expected: PASS across all packages (existing `TestAssembleServerServesSeededWorkflow` — inline connectionString — still passes, since inline-only components are unaffected by resolution).

- [ ] **Step 6: Commit**

```bash
git add cmd/reconciler.go cmd/secret_resolution_integration_test.go
git commit -m "feat(cmd): resolve state-store secretKeyRef metadata before connecting"
```

---

## Self-Review

**Spec coverage:**
- "Extend parsing to capture secretKeyRef + auth.secretStore" → Task 1. ✓
- "Detect local secret stores (local.file/local.env), ignore others" → Task 2 (`DetectSecretStores` + `TestDetectSecretStores` asserts k8s ignored). ✓
- "Resolver: local.file string + nested forms, local.env, unresolved list" → Task 2 (`ResolveSecrets`/`resolveFromFile` + 6 tests). ✓
- "Wire resolution before statestore.New for the active store" → Task 3 (reconciler, right after `Detect`, before election/open). ✓
- "Graceful degradation, never crash" → unresolved keys left unset + logged; connect fails as today. ✓
- "Inline-only unaffected" → Task 1 keeps inline in `Metadata`; `TestResolveSecrets_InlineOnlyUnchanged`; existing inline integration test stays green (Task 3 Step 5). ✓
- "Integration test: SQLite + local.file secret, no external services" → Task 3. ✓
- "Out of scope: registry file, multi-store, UI, kubernetes/remote" → none implemented; `secretstores.kubernetes` explicitly ignored. ✓

**Placeholder scan:** No TBD/TODO; every code/command is concrete.

**Type consistency:** `SecretRef{Name,Key}` and `Component.SecretRefs`/`SecretStore` (Task 1) are consumed exactly by `ResolveSecrets` (Task 2). `SecretStore{Name,Type,SecretsFile,NestedSeparator}` (Task 2) matches its test and `resolveOne`. `DetectSecretStores`/`ResolveSecrets` signatures (Task 2) match the reconciler call (Task 3). The reconciler edit replaces a verbatim existing line and reuses the in-scope `log`. The integration test reuses `wiringFakeApps`/`httpGet` from the existing `cmd` integration test file.
