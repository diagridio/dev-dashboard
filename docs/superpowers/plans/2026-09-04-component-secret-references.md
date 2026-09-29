# Component Secret References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `secretKeyRef` and `envRef` against local Dapr secret stores with the runtime's exact semantics, and surface each reference's resolution status in the dashboard.

**Architecture:** A new isolated `pkg/secrets` domain package delegates resolution to `components-contrib`'s own `secretstores/local/file` and `secretstores/local/env` implementations rather than reimplementing them. It is fed from the reconciler's full resource path provider (`rc.Paths`), the same one the Components page uses, so secret detection can never again drift from component listing. `pkg/resources` attaches value-free status to each component; a loopback-only POST endpoint reveals a single value on demand.

**Tech Stack:** Go 1.26, `github.com/dapr/components-contrib v1.18.0` (already a direct dependency — these imports add no new modules), `sigs.k8s.io/yaml`, `chi`, `testify/require`; React 18 + TypeScript + Vite, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-component-secret-references-design.md`

## Global Constraints

- **Build tags are mandatory on Go tests.** `//go:build unit` for unit tests, `//go:build integration` for integration. A plain `go test ./...` reports "no test files".
- **Gate command:** `make test` (Go `unit` with `-race`, plus web). `make test-integration` for integration. Both must pass before any commit.
- **Vitest does not typecheck.** After ANY `.ts`/`.tsx` change run `make build` (or `cd web && npx tsc -b`) — type errors have reached review in this repo before.
- **No `pkg/*` package may import `cmd/`.** `pkg/secrets` imports nothing from `cmd/`.
- **Never hardcode a color in the web UI.** Use a `var(--…)` token. `web/src/test/styleguide.test.ts` fails the build on any new hex literal.
- **Never build a CSS class name from raw data.** Namespace status classes with a component prefix (`secref-ok`, not `ok`). See `web/STYLEGUIDE.md`.
- **No secret value may appear in any list response, log line, URL, or RUM payload.** Values cross the API only through the single reveal endpoint.
- **Status enum, verbatim** — `resolved`, `store-not-specified`, `store-not-found`, `store-unsupported`, `store-unreadable`, `key-not-found`, `empty-value`, `forbidden`.
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

---

### Task 1: `pkg/secrets` types and secret-store detection

**Files:**
- Create: `pkg/secrets/types.go`
- Create: `pkg/secrets/detect.go`
- Test: `pkg/secrets/detect_test.go`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `secrets.Store`, `secrets.Ref`, `secrets.Status` (+ its constants), `secrets.Result`, and `func DetectStores(paths []string) []Store`.

- [ ] **Step 1: Write the failing test**

Create `pkg/secrets/detect_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/secrets -run TestDetectStores -v`
Expected: FAIL — the package does not exist (`no Go files in .../pkg/secrets`).

- [ ] **Step 3: Write minimal implementation**

Create `pkg/secrets/types.go`:

```go
// Package secrets resolves Dapr component secret references (secretKeyRef and
// envRef) against local secret stores. Resolution delegates to
// components-contrib's own secretstores/local/{file,env} implementations, so
// nestedSeparator flattening, multiValued, and prefix behave exactly as they
// do in the Dapr runtime rather than being re-derived here.
package secrets

import "strings"

// TypeFile and TypeEnv are the two local secret-store types this package can
// resolve. Any other secretstores.* type is detected and reported, never read.
const (
	TypeFile = "secretstores.local.file"
	TypeEnv  = "secretstores.local.env"
)

// Store is a detected secret-store component.
type Store struct {
	Name       string            // metadata.name
	Type       string            // spec.type
	Path       string            // absolute path of the YAML that declared it
	Properties map[string]string // spec.metadata, verbatim
	File       string            // local.file: the absolute secretsFile actually opened
	InitErr    string            // non-empty when the store could not be initialized
}

// Supported reports whether this package can resolve against the store.
func (s Store) Supported() bool { return s.Type == TypeFile || s.Type == TypeEnv }

// Ref is a single secret reference from a component's spec.metadata entry.
type Ref struct {
	Kind string // "secretKeyRef" | "envRef"
	Name string // secret name, or the env var name for envRef
	Key  string // "" means: fall back to Name
}

// EffectiveKey is the key actually looked up. Dapr falls back to the secret
// name when secretKeyRef.key is omitted.
func (r Ref) EffectiveKey() string {
	if r.Key == "" {
		return r.Name
	}
	return r.Key
}

// Status is the outcome of resolving one reference.
type Status string

const (
	StatusResolved          Status = "resolved"
	StatusStoreNotSpecified Status = "store-not-specified"
	StatusStoreNotFound     Status = "store-not-found"
	StatusStoreUnsupported  Status = "store-unsupported"
	StatusStoreUnreadable   Status = "store-unreadable"
	StatusKeyNotFound       Status = "key-not-found"
	StatusEmptyValue        Status = "empty-value"
	StatusForbidden         Status = "forbidden"
)

// Result is the outcome of one Resolve call. Value is populated for callers on
// the reveal path only; it must never be serialized into a list response.
type Result struct {
	Status Status
	Value  string
	Detail string // human-facing: the env var name or absolute file path tried
}

// IsSecretStoreType reports whether a component type declares a secret store.
func IsSecretStoreType(t string) bool { return strings.HasPrefix(t, "secretstores.") }
```

Create `pkg/secrets/detect.go`:

```go
package secrets

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"sigs.k8s.io/yaml"
)

// yamlDocSeparator matches a YAML document separator line ("---").
// (pkg/resources and pkg/statestore each carry their own copy; this package
// stays isolated rather than introducing a shared YAML utility package.)
var yamlDocSeparator = regexp.MustCompile(`(?m)^---\s*$`)

func splitYAMLDocs(data []byte) [][]byte {
	var docs [][]byte
	for _, doc := range yamlDocSeparator.Split(string(data), -1) {
		if strings.TrimSpace(doc) == "" {
			continue
		}
		docs = append(docs, []byte(doc))
	}
	return docs
}

type rawComponent struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Type     string `json:"type"`
		Metadata []struct {
			Name         string `json:"name"`
			Value        string `json:"value"`
			EnvRef       string `json:"envRef"`
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

// DetectStores walks the given files or directories and returns every
// secret-store component found, including unsupported types (so a reference to
// one can report store-unsupported rather than store-not-found).
func DetectStores(paths []string) []Store {
	var out []Store
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
			absPath, err := filepath.Abs(path)
			if err != nil {
				absPath = path
			}
			if seen[absPath] {
				return nil
			}
			seen[absPath] = true
			for _, doc := range splitYAMLDocs(data) {
				var rc rawComponent
				if err := yaml.Unmarshal(doc, &rc); err != nil {
					continue
				}
				if rc.Kind != "Component" || !IsSecretStoreType(rc.Spec.Type) {
					continue
				}
				props := make(map[string]string, len(rc.Spec.Metadata))
				for _, m := range rc.Spec.Metadata {
					props[m.Name] = m.Value
				}
				out = append(out, Store{
					Name: rc.Metadata.Name, Type: rc.Spec.Type,
					Path: absPath, Properties: props,
				})
			}
			return nil
		})
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/secrets -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Confirm no new modules were pulled**

Run: `go mod tidy && git diff --exit-code go.mod`
Expected: exit 0, no output. `sigs.k8s.io/yaml` is already a dependency.

- [ ] **Step 6: Commit**

```bash
git add pkg/secrets/types.go pkg/secrets/detect.go pkg/secrets/detect_test.go
git commit -m "feat(secrets): detect local secret-store components"
```

---

### Task 2: Parse secret references out of a component document

**Files:**
- Create: `pkg/secrets/refs.go`
- Test: `pkg/secrets/refs_test.go`

**Interfaces:**
- Consumes: `Ref` from Task 1.
- Produces: `func ParseRefs(doc []byte) (storeName string, refs map[string]Ref)` — maps a `spec.metadata[].name` to the reference declared on it. Used by `pkg/resources` (Task 7) so component listing and resolution agree on what a reference is.

- [ ] **Step 1: Write the failing test**

Create `pkg/secrets/refs_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/secrets -run TestParseRefs -v`
Expected: FAIL with `undefined: ParseRefs`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/secrets/refs.go`:

```go
package secrets

import "sigs.k8s.io/yaml"

// ParseRefs extracts auth.secretStore and every secret reference from a single
// component YAML document. A metadata entry is a reference when it carries a
// secretKeyRef.name or an envRef; entries with a plain value are skipped.
// Dapr gives secretKeyRef precedence over envRef when both are somehow present.
func ParseRefs(doc []byte) (storeName string, refs map[string]Ref) {
	var rc rawComponent
	if err := yaml.Unmarshal(doc, &rc); err != nil {
		return "", nil
	}
	for _, m := range rc.Spec.Metadata {
		switch {
		case m.SecretKeyRef.Name != "":
			if refs == nil {
				refs = map[string]Ref{}
			}
			refs[m.Name] = Ref{Kind: "secretKeyRef", Name: m.SecretKeyRef.Name, Key: m.SecretKeyRef.Key}
		case m.EnvRef != "":
			if refs == nil {
				refs = map[string]Ref{}
			}
			refs[m.Name] = Ref{Kind: "envRef", Name: m.EnvRef}
		}
	}
	return rc.Auth.SecretStore, refs
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/secrets -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/secrets/refs.go pkg/secrets/refs_test.go
git commit -m "feat(secrets): parse secretKeyRef and envRef from component YAML"
```

---

### Task 3: Contrib-backed store cache and `local.file` resolution

**Files:**
- Create: `pkg/secrets/resolve.go`
- Test: `pkg/secrets/resolve_file_test.go`

**Interfaces:**
- Consumes: `Store`, `Ref`, `Result`, `Status`, `DetectStores` from Tasks 1–2.
- Produces: `type Service interface { Stores(context.Context) []Store; Resolve(context.Context, string, Ref) Result; KeyNames(context.Context, string) ([]string, bool, error) }` and `func New(paths func() []string) Service`. `KeyNames`' second return is `capped`.

`KeyNames` is implemented in Task 5; this task adds the method returning `nil, false, nil` so the interface compiles.

- [ ] **Step 1: Write the failing test**

Create `pkg/secrets/resolve_file_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/secrets -run 'TestResolve' -v`
Expected: FAIL with `undefined: New` / `undefined: Service`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/secrets/resolve.go`:

```go
package secrets

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	contribmd "github.com/dapr/components-contrib/metadata"
	"github.com/dapr/components-contrib/secretstores"
	envstore "github.com/dapr/components-contrib/secretstores/local/env"
	filestore "github.com/dapr/components-contrib/secretstores/local/file"
	"github.com/dapr/kit/logger"
)

// cacheTTL bounds how long an initialized store is reused. Combined with the
// size+mtime fingerprint it keeps a same-second edit from sticking.
const cacheTTL = 2 * time.Second

// contribLogger is contrib's required logger, silenced: these stores log
// warnings we surface through Result.Status instead.
func contribLogger() logger.Logger {
	l := logger.NewLogger("dev-dashboard-secrets")
	l.SetOutputLevel(logger.FatalLevel)
	return l
}

// Service resolves secret references against detected local secret stores.
type Service interface {
	// Stores returns every detected secret-store component, with File and
	// InitErr populated for the local types.
	Stores(ctx context.Context) []Store
	// Resolve looks up ref in the store named storeName. An empty storeName
	// yields StatusStoreNotSpecified — Dapr has no default in standalone mode.
	Resolve(ctx context.Context, storeName string, ref Ref) Result
	// KeyNames returns the store's available secret names (never values).
	// capped reports whether the list was truncated.
	KeyNames(ctx context.Context, storeName string) (names []string, capped bool, err error)
}

type entry struct {
	store   secretstores.SecretStore
	file    string // resolved absolute secretsFile
	initErr string
	fp      string // size+mtime fingerprint of the backing file
	at      time.Time
}

type service struct {
	paths func() []string
	mu    sync.Mutex
	cache map[string]*entry // keyed by store identity (path|name|properties)
}

// New returns a Service scanning the paths returned by the provider on every
// call, so path changes at runtime are picked up without a restart.
func New(paths func() []string) Service {
	if paths == nil {
		paths = func() []string { return nil }
	}
	return &service{paths: paths, cache: map[string]*entry{}}
}

func (s *service) Stores(ctx context.Context) []Store {
	found := DetectStores(s.paths())
	for i := range found {
		if !found[i].Supported() {
			continue
		}
		e := s.open(found[i])
		found[i].File, found[i].InitErr = e.file, e.initErr
	}
	return found
}

// find returns the detected store with the given name.
func (s *service) find(name string) (Store, bool) {
	for _, st := range DetectStores(s.paths()) {
		if st.Name == name {
			return st, true
		}
	}
	return Store{}, false
}

// identity keys the cache on everything that changes a store's behaviour.
func identity(st Store) string {
	parts := make([]string, 0, len(st.Properties)+2)
	parts = append(parts, st.Path, st.Name, st.Type)
	for _, k := range []string{"secretsFile", "nestedSeparator", "multiValued", "prefix"} {
		parts = append(parts, k+"="+st.Properties[k])
	}
	return strings.Join(parts, "|")
}

// fileFingerprint returns a size+mtime stamp for path, or "" when unreadable.
func fileFingerprint(path string) string {
	if path == "" {
		return ""
	}
	fi, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d-%d", fi.Size(), fi.ModTime().UnixNano())
}

// resolveSecretsFile turns a possibly-relative secretsFile into an absolute
// path. Candidates, in order: an already-absolute path; the declaring YAML's
// directory; that directory's parent (the common "components/" layout, where
// daprd's own working directory is the app root). The first existing candidate
// wins; when none exist the first candidate is returned so Detail can name it.
func resolveSecretsFile(st Store) string {
	raw := st.Properties["secretsFile"]
	if raw == "" {
		return ""
	}
	if filepath.IsAbs(raw) {
		return raw
	}
	dir := filepath.Dir(st.Path)
	candidates := []string{
		filepath.Join(dir, raw),
		filepath.Join(filepath.Dir(dir), raw),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return candidates[0]
}

// open returns an initialized contrib store for st, reusing the cached one
// while its identity, backing-file fingerprint, and TTL all still hold.
func (s *service) open(st Store) *entry {
	key := identity(st)
	file := resolveSecretsFile(st)
	fp := fileFingerprint(file)

	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.cache[key]; ok && e.fp == fp && time.Since(e.at) < cacheTTL {
		return e
	}

	e := &entry{file: file, fp: fp, at: time.Now()}
	props := map[string]string{}
	for k, v := range st.Properties {
		props[k] = v
	}
	var impl secretstores.SecretStore
	switch st.Type {
	case TypeFile:
		props["secretsFile"] = file
		impl = filestore.NewLocalSecretStore(contribLogger())
	case TypeEnv:
		impl = envstore.NewEnvSecretStore(contribLogger())
	}
	if err := impl.Init(context.Background(), secretstores.Metadata{
		Base: contribmd.Base{Properties: props},
	}); err != nil {
		e.initErr = err.Error()
	} else {
		e.store = impl
	}
	s.cache[key] = e
	return e
}

// detailFor describes where a store looks things up, for the UI.
func detailFor(st Store, e *entry, ref Ref) string {
	switch st.Type {
	case TypeFile:
		return "secrets file " + e.file
	case TypeEnv:
		return "env var " + st.Properties["prefix"] + ref.Name
	}
	return ""
}

func (s *service) Resolve(ctx context.Context, storeName string, ref Ref) Result {
	if ref.Kind == "envRef" {
		return resolveEnvRef(ref)
	}
	if storeName == "" {
		return Result{Status: StatusStoreNotSpecified,
			Detail: "the component declares no auth.secretStore, and standalone Dapr has no default"}
	}
	st, ok := s.find(storeName)
	if !ok {
		return Result{Status: StatusStoreNotFound,
			Detail: fmt.Sprintf("no secret store named %q was found in the scanned resource paths", storeName)}
	}
	if !st.Supported() {
		return Result{Status: StatusStoreUnsupported,
			Detail: fmt.Sprintf("%s is not a local secret store; the dashboard does not read it", st.Type)}
	}
	e := s.open(st)
	detail := detailFor(st, e, ref)
	if e.initErr != "" || e.store == nil {
		return Result{Status: StatusStoreUnreadable, Detail: detail + ": " + e.initErr}
	}
	resp, err := e.store.GetSecret(ctx, secretstores.GetSecretRequest{Name: ref.Name})
	if err != nil {
		return Result{Status: StatusKeyNotFound, Detail: detail}
	}
	val, ok := resp.Data[ref.EffectiveKey()]
	if !ok {
		return Result{Status: StatusKeyNotFound, Detail: detail}
	}
	if val == "" {
		// Dapr applies a secret only when the value is non-empty.
		return Result{Status: StatusEmptyValue, Detail: detail}
	}
	return Result{Status: StatusResolved, Value: val, Detail: detail}
}

// KeyNames is implemented in Task 5; this stub only satisfies the interface.
func (s *service) KeyNames(ctx context.Context, storeName string) ([]string, bool, error) {
	return nil, false, nil
}
```

Add a temporary stub so the package compiles before Task 4 — create `pkg/secrets/envref.go`:

```go
package secrets

// resolveEnvRef resolves a spec.metadata[].envRef. Fully implemented in Task 4;
// this stub exists only so Task 3's package compiles and its tests can run.
func resolveEnvRef(ref Ref) Result {
	return Result{Status: StatusKeyNotFound}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/secrets -v`
Expected: PASS. If `TestResolvePicksUpFileEdits` flakes, the cache fingerprint is wrong — the fix is in `fileFingerprint`, not a longer sleep in the test.

- [ ] **Step 5: Commit**

```bash
git add pkg/secrets/resolve.go pkg/secrets/envref.go pkg/secrets/resolve_file_test.go
git commit -m "feat(secrets): resolve local.file refs via contrib's own store"
```

---

### Task 4: `local.env` resolution, `envRef`, and Dapr's denylist

**Files:**
- Modify: `pkg/secrets/envref.go` (replace the Task 3 stub)
- Test: `pkg/secrets/resolve_env_test.go`

**Interfaces:**
- Consumes: `Ref`, `Result`, `Status` from Task 1; `Service.Resolve` from Task 3.
- Produces: `func resolveEnvRef(ref Ref) Result` and `func EnvVarAllowed(key string) bool` (exported for the reveal endpoint's own check in Task 8).

- [ ] **Step 1: Write the failing test**

Create `pkg/secrets/resolve_env_test.go`:

```go
//go:build unit

package secrets

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

const envStoreWithPrefixYAML = `kind: Component
metadata:
  name: envsecrets
spec:
  type: secretstores.local.env
  metadata:
  - name: prefix
    value: MYAPP_
`

func TestResolveEnvStoreAppliesPrefix(t *testing.T) {
	t.Setenv("MYAPP_REDIS_PASSWORD", "from-env")
	svc, _ := writeStore(t, envStoreWithPrefixYAML, "")
	ctx := context.Background()

	// The ref names the secret WITHOUT the prefix; contrib prepends it.
	got := svc.Resolve(ctx, "envsecrets", Ref{Kind: "secretKeyRef", Name: "REDIS_PASSWORD"})
	require.Equal(t, StatusResolved, got.Status)
	require.Equal(t, "from-env", got.Value)
	require.Contains(t, got.Detail, "MYAPP_REDIS_PASSWORD")

	// An unset variable is empty, not resolved.
	got = svc.Resolve(ctx, "envsecrets", Ref{Kind: "secretKeyRef", Name: "NOT_SET"})
	require.Equal(t, StatusEmptyValue, got.Status)
}

func TestResolveEnvStoreDenylist(t *testing.T) {
	t.Setenv("DAPR_SECRET", "nope")
	svc, _ := writeStore(t, `kind: Component
metadata:
  name: envsecrets
spec:
  type: secretstores.local.env
`, "")
	got := svc.Resolve(context.Background(), "envsecrets", Ref{Kind: "secretKeyRef", Name: "DAPR_SECRET"})
	require.NotEqual(t, StatusResolved, got.Status, "DAPR_* must never be readable")
}

func TestResolveEnvRef(t *testing.T) {
	t.Setenv("MY_TOKEN", "tok")
	svc, _ := writeStore(t, envStoreWithPrefixYAML, "")
	ctx := context.Background()

	// envRef bypasses the secret store entirely: no prefix, no store lookup.
	got := svc.Resolve(ctx, "", Ref{Kind: "envRef", Name: "MY_TOKEN"})
	require.Equal(t, StatusResolved, got.Status)
	require.Equal(t, "tok", got.Value)
	require.Contains(t, got.Detail, "MY_TOKEN")

	require.Equal(t, StatusEmptyValue, svc.Resolve(ctx, "", Ref{Kind: "envRef", Name: "UNSET_VAR"}).Status)
}

func TestEnvVarAllowed(t *testing.T) {
	require.True(t, EnvVarAllowed("MY_TOKEN"))
	require.False(t, EnvVarAllowed(""))
	require.False(t, EnvVarAllowed("APP_API_TOKEN"))
	require.False(t, EnvVarAllowed("app_api_token"), "the check is case-insensitive")
	require.False(t, EnvVarAllowed("DAPR_API_TOKEN"))
	require.False(t, EnvVarAllowed("has space"))
}

func TestResolveEnvRefForbidden(t *testing.T) {
	t.Setenv("DAPR_API_TOKEN", "nope")
	svc, _ := writeStore(t, envStoreWithPrefixYAML, "")
	got := svc.Resolve(context.Background(), "", Ref{Kind: "envRef", Name: "DAPR_API_TOKEN"})
	require.Equal(t, StatusForbidden, got.Status)
	require.Empty(t, got.Value)
}

func TestEnvKeysAllowlist(t *testing.T) {
	// DAPR_ENV_KEYS is injector-set and Kubernetes-only, but Dapr honours it,
	// so mirroring it keeps behaviour identical wherever it happens to be set.
	t.Setenv("DAPR_ENV_KEYS", "ALLOWED_ONE ALLOWED_TWO")
	require.True(t, EnvVarAllowed("ALLOWED_ONE"))
	require.True(t, EnvVarAllowed("ALLOWED_TWO"))
	require.False(t, EnvVarAllowed("OTHER"))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/secrets -run 'Env' -v`
Expected: FAIL — `undefined: EnvVarAllowed`, and the `envRef` tests return `key-not-found` from the stub.

- [ ] **Step 3: Write minimal implementation**

Replace `pkg/secrets/envref.go` entirely:

```go
package secrets

import (
	"os"
	"strings"
)

// EnvVarAllowed mirrors dapr/pkg/runtime/processor/secret.isEnvVarAllowed:
// a denylist of empty names, APP_API_TOKEN, any DAPR_-prefixed name, and any
// name containing a space; then, when DAPR_ENV_KEYS is set (the Kubernetes
// injector sets it), a space-separated allowlist on top.
func EnvVarAllowed(key string) bool {
	upper := strings.ToUpper(key)
	switch {
	case upper == "":
		return false
	case upper == "APP_API_TOKEN":
		return false
	case strings.HasPrefix(upper, "DAPR_"):
		return false
	case strings.Contains(upper, " "):
		return false
	}

	allowlist := os.Getenv("DAPR_ENV_KEYS")
	if allowlist == "" {
		return true
	}
	for _, allowed := range strings.Split(allowlist, " ") {
		if allowed == key {
			return true
		}
	}
	return false
}

// resolveEnvRef resolves a spec.metadata[].envRef straight from the
// environment, exactly as the runtime does: no secret store, no prefix.
func resolveEnvRef(ref Ref) Result {
	detail := "env var " + ref.Name
	if !EnvVarAllowed(ref.Name) {
		return Result{Status: StatusForbidden,
			Detail: detail + " is on Dapr's denylist (DAPR_*, APP_API_TOKEN, names with spaces)"}
	}
	val := os.Getenv(ref.Name)
	if val == "" {
		return Result{Status: StatusEmptyValue, Detail: detail}
	}
	return Result{Status: StatusResolved, Value: val, Detail: detail}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/secrets -v`
Expected: PASS (all tests from Tasks 1–4).

Note on `TestResolveEnvStoreDenylist`: contrib's env store applies its own denylist internally and returns an empty value, so the status will be `empty-value`. The assertion is deliberately `NotEqual(StatusResolved)` — it pins the security property without over-specifying contrib's reporting.

- [ ] **Step 5: Commit**

```bash
git add pkg/secrets/envref.go pkg/secrets/resolve_env_test.go
git commit -m "feat(secrets): resolve local.env refs and envRef with Dapr's denylist"
```

---

### Task 5: `KeyNames` with an explicit cap

**Files:**
- Modify: `pkg/secrets/resolve.go` (replace the `KeyNames` stub)
- Test: `pkg/secrets/keynames_test.go`

**Interfaces:**
- Consumes: `Service`, `service.open`, `service.find` from Task 3.
- Produces: working `KeyNames(ctx, storeName) (names []string, capped bool, err error)`, sorted, capped at `MaxKeyNames = 200`.

- [ ] **Step 1: Write the failing test**

Create `pkg/secrets/keynames_test.go`:

```go
//go:build unit

package secrets

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestKeyNamesFileStore(t *testing.T) {
	svc, _ := writeStore(t, fileStoreDefaultYAML,
		`{"zeta":"1","alpha":"2","redis":{"password":"3"}}`)

	names, capped, err := svc.KeyNames(context.Background(), "localsecretstore")
	require.NoError(t, err)
	require.False(t, capped)
	// Sorted, and nested keys appear in their flattened form — which is the
	// form a secretKeyRef must use.
	require.Equal(t, []string{"alpha", "redis:password", "zeta"}, names)
}

func TestKeyNamesCaps(t *testing.T) {
	payload := map[string]string{}
	for i := 0; i < MaxKeyNames+50; i++ {
		payload[fmt.Sprintf("key%04d", i)] = "v"
	}
	blob, err := json.Marshal(payload)
	require.NoError(t, err)

	svc, _ := writeStore(t, fileStoreDefaultYAML, string(blob))
	names, capped, err := svc.KeyNames(context.Background(), "localsecretstore")
	require.NoError(t, err)
	require.True(t, capped)
	require.Len(t, names, MaxKeyNames)
}

func TestKeyNamesEnvStoreRequiresPrefix(t *testing.T) {
	ctx := context.Background()

	// No prefix: listing would dump the whole environment, so refuse.
	svc, _ := writeStore(t, `kind: Component
metadata:
  name: envsecrets
spec:
  type: secretstores.local.env
`, "")
	names, _, err := svc.KeyNames(ctx, "envsecrets")
	require.NoError(t, err)
	require.Nil(t, names)

	// With a prefix, only matching names are listed (prefix stripped).
	t.Setenv("MYAPP_ONE", "1")
	svc, _ = writeStore(t, envStoreWithPrefixYAML, "")
	names, _, err = svc.KeyNames(ctx, "envsecrets")
	require.NoError(t, err)
	require.Contains(t, names, "ONE")
}

func TestKeyNamesUnknownStore(t *testing.T) {
	svc, _ := writeStore(t, fileStoreDefaultYAML, `{"a":"b"}`)
	_, _, err := svc.KeyNames(context.Background(), "nope")
	require.Error(t, err)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/secrets -run TestKeyNames -v`
Expected: FAIL — `undefined: MaxKeyNames`, and the stub returns `nil, false, nil`.

- [ ] **Step 3: Write minimal implementation**

In `pkg/secrets/resolve.go`, add the constant near `cacheTTL`:

```go
// MaxKeyNames caps how many secret names KeyNames returns. The cap is reported
// to the caller rather than applied silently.
const MaxKeyNames = 200
```

Replace the `KeyNames` stub with:

```go
// KeyNames returns the store's available secret names, never their values.
// For local.env a prefix is required: without one, listing would enumerate the
// caller's entire environment, so it returns nil.
func (s *service) KeyNames(ctx context.Context, storeName string) ([]string, bool, error) {
	st, ok := s.find(storeName)
	if !ok {
		return nil, false, fmt.Errorf("no secret store named %q", storeName)
	}
	if !st.Supported() {
		return nil, false, fmt.Errorf("%s is not a local secret store", st.Type)
	}
	if st.Type == TypeEnv && st.Properties["prefix"] == "" {
		return nil, false, nil
	}
	e := s.open(st)
	if e.store == nil {
		return nil, false, fmt.Errorf("secret store %q is unreadable: %s", storeName, e.initErr)
	}
	resp, err := e.store.BulkGetSecret(ctx, secretstores.BulkGetSecretRequest{})
	if err != nil {
		return nil, false, err
	}
	names := make([]string, 0, len(resp.Data))
	for k := range resp.Data {
		names = append(names, k)
	}
	sort.Strings(names)
	if len(names) > MaxKeyNames {
		return names[:MaxKeyNames], true, nil
	}
	return names, false, nil
}
```

Add `"sort"` to the imports in `pkg/secrets/resolve.go`.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/secrets -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/secrets/resolve.go pkg/secrets/keynames_test.go
git commit -m "feat(secrets): list secret key names with an explicit cap"
```

---

### Task 6: Wire `cmd/reconciler` to `pkg/secrets`; delete the old resolver

**Files:**
- Delete: `pkg/statestore/secrets.go`, `pkg/statestore/secrets_test.go`
- Modify: `cmd/reconciler.go` (lines ~135-160, ~235-290)
- Modify: `cmd/serve.go:152`
- Test: `cmd/secrets_paths_test.go` (create)

**Interfaces:**
- Consumes: `secrets.New`, `secrets.Service`, `secrets.Resolve`, `secrets.Status` from Tasks 1–5; `statestore.Component.SecretRefs` / `.SecretStore` (unchanged).
- Produces: `reconciler.secrets secrets.Service` field, and `func resolveComponentSecrets(svc secrets.Service, c statestore.Component) (resolved map[string]string, issue string)` in `cmd/reconciler.go` — `issue` is the one-sentence diagnostic consumed by Task 9.

- [ ] **Step 1: Write the failing test**

Create `cmd/secrets_paths_test.go`:

```go
//go:build unit

package cmd

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/stretchr/testify/require"
)

const secretStoreYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: localsecretstore
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: secrets.json
`

// Regression: --statestore used to collapse the scan path set to a single YAML,
// which made secret-store detection find nothing at all. Secret detection now
// runs over resPaths (the full resource path set), so the flag cannot disable it.
func TestSecretStoresDetectedWithExplicitStatestorePath(t *testing.T) {
	home := t.TempDir()
	compDir := filepath.Join(home, ".dapr", "components")
	require.NoError(t, os.MkdirAll(compDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(compDir, "secretstore.yaml"), []byte(secretStoreYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(compDir, "secrets.json"), []byte(`{"pw":"v"}`), 0o600))

	explicit := filepath.Join(home, "explicit-statestore.yaml")
	require.NoError(t, os.WriteFile(explicit, []byte("kind: Component\nmetadata:\n  name: s\nspec:\n  type: state.redis\n"), 0o600))

	resPaths, scanPaths, _, _ := derivePaths(nil, home, explicit, nil)
	require.Equal(t, []string{explicit}, scanPaths, "state-store scanning is still narrowed by the flag")

	svc := secrets.New(func() []string { return resPaths })
	require.Len(t, svc.Stores(context.Background()), 1, "secret detection must not be narrowed by --statestore")
}

// Regression: a secret store outside ~/.dapr/components but inside ~/.dapr was
// listed by the Components page yet invisible to the resolver.
func TestSecretStoreUnderDaprHomeIsDetected(t *testing.T) {
	home := t.TempDir()
	resDir := filepath.Join(home, ".dapr", "resources")
	require.NoError(t, os.MkdirAll(resDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(resDir, "secretstore.yaml"), []byte(secretStoreYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(resDir, "secrets.json"), []byte(`{"pw":"v"}`), 0o600))

	resPaths, _, _, _ := derivePaths([]discovery.Instance{}, home, "", nil)
	svc := secrets.New(func() []string { return resPaths })
	stores := svc.Stores(context.Background())
	require.Len(t, stores, 1)
	require.Equal(t, "localsecretstore", stores[0].Name)
	require.Empty(t, stores[0].InitErr)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./cmd -run TestSecretStore -v`
Expected: FAIL — `pkg/secrets` is not yet imported by `cmd`, and `derivePaths` may dedupe differently. Read the failure before changing anything.

- [ ] **Step 3: Write minimal implementation**

In `cmd/reconciler.go`:

1. Add `"github.com/diagridio/dev-dashboard/pkg/secrets"` to the imports and a `secretsSvc secrets.Service` field on `reconciler`; set it in `newReconciler` with `secrets.New(rc.Paths)` **after** `rc` is constructed (it closes over `rc`).

2. Add the shared helper:

```go
// resolveComponentSecrets returns c.Metadata with every secretKeyRef applied,
// plus a one-sentence diagnostic naming the first unresolved reference (empty
// when everything resolved). The diagnostic is what the connections panel and
// the State page show instead of an opaque dial failure.
func resolveComponentSecrets(svc secrets.Service, c statestore.Component) (map[string]string, string) {
	out := make(map[string]string, len(c.Metadata)+len(c.SecretRefs))
	for k, v := range c.Metadata {
		out[k] = v
	}
	if len(c.SecretRefs) == 0 || svc == nil {
		return out, ""
	}
	// Sort field names so the reported issue is deterministic across runs.
	fields := make([]string, 0, len(c.SecretRefs))
	for f := range c.SecretRefs {
		fields = append(fields, f)
	}
	sort.Strings(fields)

	var issue string
	for _, field := range fields {
		ref := c.SecretRefs[field]
		res := svc.Resolve(context.Background(), c.SecretStore, secrets.Ref{
			Kind: "secretKeyRef", Name: ref.Name, Key: ref.Key,
		})
		if res.Status == secrets.StatusResolved {
			out[field] = res.Value
			continue
		}
		if issue == "" {
			issue = fmt.Sprintf("%s unresolved (%s): %s", field, res.Status, res.Detail)
		}
	}
	return out, issue
}
```

3. Replace the `statestore.DetectSecretStores` / `statestore.ResolveSecrets` block in `reconcile` (currently lines ~140-152) with:

```go
	for i := range detected {
		resolved, issue := resolveComponentSecrets(rc.secretsSvc, detected[i])
		detected[i].Metadata = resolved
		if issue != "" {
			log.Warn("unresolved secret reference", "store", detected[i].Name, "issue", issue)
		}
		// Auto-persist every detected store as a path-ref. Persist the YAML path,
		// not the resolved metadata, so no secrets land in the registry file.
		if rc.registry != nil {
			if err := rc.registry.UpsertAuto(ConnEntry{
				Name: detected[i].Name, Type: detected[i].Type, Source: SourceAuto, Path: detected[i].Path,
			}); err != nil {
				log.Warn("auto-persist store failed", "store", detected[i].Name, "err", err)
			}
		}
	}
```

4. Delete the `autoDetection` struct's `secretStores` field and the `DetectSecretStores` call in `detectAuto`; in `componentForEntry`, replace the `statestore.ResolveSecrets` call with `resolveComponentSecrets(rc.secretsSvc, c)`, discarding the issue for now (Task 9 threads it through).

5. Delete `pkg/statestore/secrets.go` and `pkg/statestore/secrets_test.go`. Keep `Component.SecretRefs`, `Component.SecretStore`, and `SecretRef` in `pkg/statestore/store.go` — `Detect` still populates them.

In `cmd/serve.go`, line 152 becomes:

```go
		Resources:        resources.New(rc.Paths, deps.ExtraResources, resources.WithSecrets(rc.secretsSvc)),
```

`resources.WithSecrets` does not exist yet — add a no-op placeholder in `pkg/resources/resources.go` now so the build stays green, and implement it in Task 7:

```go
// Option configures the resources Service.
type Option func(*service)

// WithSecrets attaches a secret resolver so component resources carry secret
// reference status. Implemented in the next task.
func WithSecrets(svc secrets.Service) Option {
	return func(s *service) { s.secrets = svc }
}
```

with a `secrets secrets.Service` field on `service` and `New` accepting `opts ...Option`.

- [ ] **Step 4: Run the tests**

Run: `go test -tags unit ./cmd/... ./pkg/... -v 2>&1 | tail -30`
Expected: PASS. `grep -rn "DetectSecretStores\|ResolveSecrets" cmd pkg --include="*.go"` must return nothing.

- [ ] **Step 5: Run the full gate**

Run: `make test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(secrets): resolve state-store secrets via pkg/secrets

Secret detection now runs over the full resource path set instead of the
state-store scan paths, so --statestore no longer disables it and a store
under ~/.dapr outside components/ is found."
```

---

### Task 7: Attach secret status to component resources

**Files:**
- Modify: `pkg/resources/resources.go`
- Create: `pkg/resources/secrets.go`
- Test: `pkg/resources/secrets_test.go`

**Interfaces:**
- Consumes: `secrets.Service`, `secrets.ParseRefs`, `secrets.Status`, `secrets.IsSecretStoreType`, `secrets.MaxKeyNames` from Tasks 1–5; `resources.WithSecrets` placeholder from Task 6.
- Produces: `resources.SecretRefStatus`, `resources.SecretStoreInfo`, and the `Resource.SecretRefs []SecretRefStatus` / `Resource.SecretStore *SecretStoreInfo` fields.

- [ ] **Step 1: Write the failing test**

Create `pkg/resources/secrets_test.go`:

```go
//go:build unit

package resources

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/stretchr/testify/require"
)

const storeCompYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: localsecretstore
spec:
  type: secretstores.local.file
  version: v1
  metadata:
  - name: secretsFile
    value: secrets.json
`

const refCompYAML = `apiVersion: dapr.io/v1alpha1
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
  - name: missing
    secretKeyRef:
      name: nope
auth:
  secretStore: localsecretstore
`

func newSecretsFixture(t *testing.T) (Service, string) {
	t.Helper()
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secretstore.yaml"), []byte(storeCompYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(refCompYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"),
		[]byte(`{"redis":{"password":"s3cr3t"}}`), 0o600))
	paths := func() []string { return []string{dir} }
	return New(paths, nil, WithSecrets(secrets.New(paths))), dir
}

func TestListCarriesSecretRefStatus(t *testing.T) {
	svc, _ := newSecretsFixture(t)

	list, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)

	var ss Resource
	for _, r := range list {
		if r.Name == "statestore" {
			ss = r
		}
	}
	require.Len(t, ss.SecretRefs, 2)

	byField := map[string]SecretRefStatus{}
	for _, s := range ss.SecretRefs {
		byField[s.Field] = s
	}
	require.Equal(t, string(secrets.StatusResolved), byField["redisPassword"].Status)
	require.Equal(t, "localsecretstore", byField["redisPassword"].Store)
	require.Equal(t, "redis:password", byField["redisPassword"].Name)
	require.Equal(t, string(secrets.StatusKeyNotFound), byField["missing"].Status)
	require.NotEmpty(t, byField["missing"].Detail, "a failure must say what was tried")
}

// The standing convention in this repo is that secret material never crosses
// the API boundary. This is its regression guard.
func TestSecretValuesNeverSerialized(t *testing.T) {
	svc, _ := newSecretsFixture(t)

	list, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	blob, err := json.Marshal(list)
	require.NoError(t, err)
	require.NotContains(t, string(blob), "s3cr3t")

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	blob, err = json.Marshal(got)
	require.NoError(t, err)
	require.NotContains(t, string(blob), "s3cr3t")
}

func TestGetPopulatesSecretStoreInfo(t *testing.T) {
	svc, dir := newSecretsFixture(t)

	got, err := svc.Get(context.Background(), KindComponent, "localsecretstore")
	require.NoError(t, err)
	require.NotNil(t, got.SecretStore)
	require.Equal(t, "secretstores.local.file", got.SecretStore.Type)
	require.Equal(t, filepath.Join(dir, "secrets.json"), got.SecretStore.File)
	require.Equal(t, []string{"redis:password"}, got.SecretStore.Keys)
	require.Equal(t, []string{"statestore"}, got.SecretStore.UsedBy)
	require.Empty(t, got.SecretStore.InitErr)
}

func TestNonSecretStoreHasNoStoreInfo(t *testing.T) {
	svc, _ := newSecretsFixture(t)
	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Nil(t, got.SecretStore)
}

func TestNilSecretsServiceIsSafe(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "c.yaml"), []byte(refCompYAML), 0o600))
	svc := New(func() []string { return []string{dir} }, nil) // no WithSecrets

	list, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Empty(t, list[0].SecretRefs)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/resources -run Secret -v`
Expected: FAIL — `Resource` has no field `SecretRefs`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/resources/secrets.go`:

```go
package resources

import (
	"context"

	"github.com/diagridio/dev-dashboard/pkg/secrets"
)

// SecretRefStatus is one component metadata field that draws its value from a
// secret reference, with the outcome of resolving it. It never carries the
// value itself — see the reveal endpoint in pkg/server.
type SecretRefStatus struct {
	Field  string `json:"field"`
	Kind   string `json:"kind"`
	Store  string `json:"store,omitempty"`
	Name   string `json:"name,omitempty"`
	Key    string `json:"key,omitempty"`
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// SecretStoreInfo describes a local secret-store component for its detail pane.
// Keys are names only.
type SecretStoreInfo struct {
	Name       string   `json:"name"`
	Type       string   `json:"type"`
	File       string   `json:"file,omitempty"`
	Prefix     string   `json:"prefix,omitempty"`
	Keys       []string `json:"keys,omitempty"`
	KeysCapped bool     `json:"keysCapped,omitempty"`
	InitErr    string   `json:"initErr,omitempty"`
	UsedBy     []string `json:"usedBy,omitempty"`
}

// secretRefsFor resolves every reference declared in doc. Returns nil when the
// document declares none or no resolver is configured.
func (s *service) secretRefsFor(ctx context.Context, doc []byte) []SecretRefStatus {
	if s.secrets == nil {
		return nil
	}
	storeName, refs := secrets.ParseRefs(doc)
	if len(refs) == 0 {
		return nil
	}
	out := make([]SecretRefStatus, 0, len(refs))
	for field, ref := range refs {
		res := s.secrets.Resolve(ctx, storeName, ref)
		out = append(out, SecretRefStatus{
			Field: field, Kind: ref.Kind, Store: storeName,
			Name: ref.Name, Key: ref.Key,
			Status: string(res.Status), Detail: res.Detail,
		})
	}
	sortByField(out)
	return out
}

// secretStoreInfoFor builds the detail-pane payload for a secret-store
// component, including which components reference it.
func (s *service) secretStoreInfoFor(ctx context.Context, r Resource) *SecretStoreInfo {
	if s.secrets == nil || !secrets.IsSecretStoreType(r.Type) {
		return nil
	}
	var st secrets.Store
	for _, candidate := range s.secrets.Stores(ctx) {
		if candidate.Name == r.Name {
			st = candidate
			break
		}
	}
	if st.Name == "" {
		return nil
	}
	info := &SecretStoreInfo{
		Name: st.Name, Type: st.Type, File: st.File,
		Prefix: st.Properties["prefix"], InitErr: st.InitErr,
	}
	info.Keys, info.KeysCapped, _ = s.secrets.KeyNames(ctx, r.Name)
	info.UsedBy = s.usedBy(ctx, r.Name)
	return info
}

// usedBy returns the names of components whose auth.secretStore is storeName.
func (s *service) usedBy(ctx context.Context, storeName string) []string {
	var out []string
	for _, r := range s.rawComponentDocs() {
		declared, refs := secrets.ParseRefs(r.doc)
		if declared == storeName && len(refs) > 0 {
			out = append(out, r.name)
		}
	}
	sortStrings(out)
	return out
}
```

In `pkg/resources/resources.go`, add the two fields to `Resource` plus an
unexported one carrying the document the resource was parsed from, so
`secretRefsFor` never re-reads the file:

```go
type Resource struct {
	// …existing fields…
	SecretRefs  []SecretRefStatus `json:"secretRefs,omitempty"`
	SecretStore *SecretStoreInfo  `json:"secretStore,omitempty"`

	// doc is the single YAML document this resource was parsed from. It is
	// unexported, so it never reaches the API; secret-reference parsing reads
	// it instead of re-walking the file.
	doc []byte
}
```

Populate `doc` in both parsers. In `scan`'s inner loop:

```go
				out = append(out, Resource{
					ID:      resourceID(rr.Metadata.Name, rr.Spec.Type, absPath),
					Name:    rr.Metadata.Name,
					Kind:    k,
					Type:    rr.Spec.Type,
					Version: rr.Spec.Version,
					Path:    absPath,
					doc:     doc,
				})
```

and the same `doc: doc,` line in `FromRaw`'s append, so container-sourced
extras carry their document too.

Add the option plumbing (the `WithSecrets` stub from Task 6 becomes real):

```go
type service struct {
	paths   func() []string
	extras  func() []Resource
	secrets secrets.Service
}

// Option configures the resources Service.
type Option func(*service)

// WithSecrets attaches a secret resolver so component resources carry secret
// reference status. Without it, SecretRefs and SecretStore stay empty.
func WithSecrets(svc secrets.Service) Option {
	return func(s *service) { s.secrets = svc }
}

func New(paths func() []string, extras func() []Resource, opts ...Option) Service {
	if paths == nil {
		paths = func() []string { return nil }
	}
	s := &service{paths: paths, extras: extras}
	for _, o := range opts {
		o(s)
	}
	return s
}
```

Populate the status in `List`, after the existing sort:

```go
	for i := range out {
		if out[i].Kind == KindComponent {
			out[i].SecretRefs = s.secretRefsFor(ctx, out[i].doc)
		}
	}
```

and in `Get`, on every return path that yields a component — factor the two
`withRaw` branches and the two extras branches through one helper so no path is
missed:

```go
// enrich attaches secret-reference status and, for secret-store components,
// the store detail payload.
func (s *service) enrich(ctx context.Context, r Resource) Resource {
	if r.Kind != KindComponent {
		return r
	}
	r.SecretRefs = s.secretRefsFor(ctx, r.doc)
	r.SecretStore = s.secretStoreInfoFor(ctx, r)
	return r
}
```

Wrap each of `Get`'s four returns as `return s.enrich(ctx, r), nil` (and
`withRaw` becomes `return s.enrich(ctx, r), nil` after setting `Raw`).

Finally, in `pkg/resources/secrets.go`, implement `usedBy` over `scan` rather
than a third walker, and the two sort helpers:

```go
// usedBy returns the names of components whose auth.secretStore is storeName.
func (s *service) usedBy(ctx context.Context, storeName string) []string {
	scanned, err := s.scan(KindComponent)
	if err != nil {
		return nil
	}
	all := append(scanned, s.extraByKind(KindComponent)...)
	var out []string
	seen := map[string]bool{}
	for _, r := range all {
		declared, refs := secrets.ParseRefs(r.doc)
		if declared == storeName && len(refs) > 0 && !seen[r.Name] {
			seen[r.Name] = true
			out = append(out, r.Name)
		}
	}
	sortStrings(out)
	return out
}

func sortByField(in []SecretRefStatus) {
	sort.Slice(in, func(i, j int) bool { return in[i].Field < in[j].Field })
}

func sortStrings(in []string) { sort.Strings(in) }
```

Remove the placeholder `usedBy` from the `secrets.go` listing above and use
this one; add `"sort"` to that file's imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/resources -v`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `make test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/resources/ 
git commit -m "feat(resources): attach secret reference status to components"
```

---

### Task 7b: Container-declared secret stores degrade honestly

A Testcontainers or compose app can declare its secret store *inside* the
container. `pkg/resources` surfaces those through its `extras` provider, but
`secrets.DetectStores` only walks host paths — so a component referencing one
would report `store-not-found`, which is wrong and misleading. It exists; the
host just cannot read it.

**Files:**
- Modify: `pkg/resources/secrets.go`
- Test: `pkg/resources/secrets_container_test.go`

**Interfaces:**
- Consumes: `secretRefsFor` (Task 7), `secrets.StatusStoreNotFound`, `secrets.StatusStoreUnreadable`, `secrets.IsSecretStoreType`.
- Produces: no new exported names.

- [ ] **Step 1: Write the failing test**

Create `pkg/resources/secrets_container_test.go`:

```go
//go:build unit

package resources

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/stretchr/testify/require"
)

const containerStoreYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: containerstore
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: /dapr-resources/secrets.json
`

const containerRefYAML = `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  metadata:
  - name: redisPassword
    secretKeyRef:
      name: pw
auth:
  secretStore: containerstore
`

func TestContainerDeclaredStoreReportsUnreadable(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(containerRefYAML), 0o600))

	paths := func() []string { return []string{dir} }
	// The secret store exists only inside a container, surfaced via extras.
	extras := func() []Resource {
		return FromRaw("crazy_lamport:/dapr-resources", []byte(containerStoreYAML))
	}
	svc := New(paths, extras, WithSecrets(secrets.New(paths)))

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Len(t, got.SecretRefs, 1)
	require.Equal(t, string(secrets.StatusStoreUnreadable), got.SecretRefs[0].Status)
	require.Contains(t, got.SecretRefs[0].Detail, "crazy_lamport")
}

func TestGenuinelyMissingStoreStillReportsNotFound(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(containerRefYAML), 0o600))

	paths := func() []string { return []string{dir} }
	svc := New(paths, nil, WithSecrets(secrets.New(paths)))

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Len(t, got.SecretRefs, 1)
	require.Equal(t, string(secrets.StatusStoreNotFound), got.SecretRefs[0].Status)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/resources -run Container -v`
Expected: FAIL — the first test reports `store-not-found`, not `store-unreadable`.

- [ ] **Step 3: Write minimal implementation**

In `pkg/resources/secrets.go`, add the lookup and apply it inside
`secretRefsFor`:

```go
// containerStorePath returns the display path of an extras-provided secret
// store with the given name. Extras carry a "<container>:<in-container-path>"
// display path, so the host filesystem has no copy of the store's data.
func (s *service) containerStorePath(storeName string) (string, bool) {
	for _, r := range s.extraByKind(KindComponent) {
		if r.Name == storeName && secrets.IsSecretStoreType(r.Type) {
			return r.Path, true
		}
	}
	return "", false
}
```

and in `secretRefsFor`, immediately after computing `res`:

```go
		status, detail := res.Status, res.Detail
		if status == secrets.StatusStoreNotFound {
			if p, ok := s.containerStorePath(storeName); ok {
				status = secrets.StatusStoreUnreadable
				detail = "declared inside container " + p +
					"; its secrets are not readable from this host"
			}
		}
```

then build the `SecretRefStatus` from `status`/`detail` rather than
`res.Status`/`res.Detail`.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/resources -v`
Expected: PASS — including the Task 7 tests, which must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add pkg/resources/secrets.go pkg/resources/secrets_container_test.go
git commit -m "feat(resources): report container-declared secret stores as unreadable"
```

---

### Task 8: The reveal endpoint and its capability flag

**Files:**
- Modify: `pkg/server/resources.go`
- Modify: `pkg/server/server.go` (the `Capabilities` struct + `FullCapabilities`)
- Modify: `pkg/server/api.go` (pass the reveal gate into `resourcesRouter`)
- Modify: `cmd/serve.go` (set the flag from `AllowNonLoopback`)
- Test: `pkg/server/resources_secret_test.go`

**Interfaces:**
- Consumes: `resources.Service`, `secrets.Service` from Task 7.
- Produces: `POST /api/resources/component/{id}/secret-value` and `Capabilities.SecretReveal bool` (JSON `secretReveal`). Request body `{"field":"<name>"}`, response `{"value":"..."}`.

The handler needs the raw value, which `resources.Service` deliberately never returns. Add one method to `resources.Service`:

```go
// RevealSecret returns the resolved value of a single secret reference on a
// component. It is the only path by which secret material leaves this package.
RevealSecret(ctx context.Context, idOrName, field string) (string, error)
```

with `resources.ErrNoSecretValue` returned when the field has no reference or does not resolve.

- [ ] **Step 1: Write the failing test**

Create `pkg/server/resources_secret_test.go`:

```go
//go:build unit

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/stretchr/testify/require"
)

type revealResources struct {
	fakeResources
	value string
	err   error
}

func (r revealResources) RevealSecret(_ context.Context, _, _ string) (string, error) {
	return r.value, r.err
}

func revealServer(t *testing.T, res resources.Service, allowNonLoopback bool) http.Handler {
	t.Helper()
	return NewRouter(Options{
		DistFS:           emptyFS(t),
		Resources:        res,
		AllowNonLoopback: allowNonLoopback,
		ListenPort:       9090,
	})
}

func postReveal(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/resources/component/abc123/secret-value", strings.NewReader(body))
	req.Host = "127.0.0.1:9090"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRevealReturnsValueOnLoopback(t *testing.T) {
	h := revealServer(t, revealResources{value: "s3cr3t"}, false)
	rec := postReveal(t, h, `{"field":"redisPassword"}`)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))

	var body struct {
		Value string `json:"value"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "s3cr3t", body.Value)
}

func TestRevealForbiddenWhenServedOffHost(t *testing.T) {
	h := revealServer(t, revealResources{value: "s3cr3t"}, true)
	rec := postReveal(t, h, `{"field":"redisPassword"}`)

	require.Equal(t, http.StatusForbidden, rec.Code)
	require.NotContains(t, rec.Body.String(), "s3cr3t")
}

func TestRevealNotFoundForUnknownField(t *testing.T) {
	h := revealServer(t, revealResources{err: resources.ErrNoSecretValue}, false)
	rec := postReveal(t, h, `{"field":"nope"}`)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestRevealRejectsGet(t *testing.T) {
	h := revealServer(t, revealResources{value: "s3cr3t"}, false)
	req := httptest.NewRequest(http.MethodGet, "/api/resources/component/abc123/secret-value", nil)
	req.Host = "127.0.0.1:9090"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusMethodNotAllowed, rec.Code)
	require.NotContains(t, rec.Body.String(), "s3cr3t")
}

func TestCapabilitiesReportSecretReveal(t *testing.T) {
	require.True(t, FullCapabilities().SecretReveal)
}
```

Reuse the existing `fakeResources` helper in `pkg/server/resources_test.go` and whatever empty-FS helper that file already uses; if there is no `emptyFS`, copy the pattern from `pkg/server/server_test.go` rather than inventing one.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/server -run Reveal -v`
Expected: FAIL — the route 404s and `Capabilities` has no `SecretReveal`.

- [ ] **Step 3: Write minimal implementation**

In `pkg/server/server.go`, add to `Capabilities`:

```go
	// SecretReveal gates the per-field secret reveal endpoint. It is off
	// whenever the dashboard is served off-host (AllowNonLoopback), because
	// that posture can be reached through a proxy from another machine.
	SecretReveal bool `json:"secretReveal"`
```

and set `SecretReveal: true` in `FullCapabilities()`. In `NewRouter`, after `caps` is resolved:

```go
	if opts.AllowNonLoopback {
		caps.SecretReveal = false
	}
```

In `pkg/server/resources.go`, extend `resourcesRouter(res resources.Service, apps discovery.Service, revealEnabled bool)` with:

```go
	r.Post("/component/{id}/secret-value", func(w http.ResponseWriter, req *http.Request) {
		if !revealEnabled {
			writeJSON(w, http.StatusForbidden,
				map[string]string{"error": "secret reveal is disabled when the dashboard is served off-host"})
			return
		}
		var body struct {
			Field string `json:"field"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil || body.Field == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "field is required"})
			return
		}
		id := chi.URLParam(req, "id")
		val, err := res.RevealSecret(req.Context(), id, body.Field)
		if errors.Is(err, resources.ErrNotFound) || errors.Is(err, resources.ErrNoSecretValue) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no resolved secret for that field"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		slog.Default().With("component", "resources").Info("secret revealed", "resource", id, "field", body.Field)
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]string{"value": val})
	})
```

Update the `apiRouter` call site in `pkg/server/api.go` to pass `caps.SecretReveal`.

In `pkg/resources`, add `ErrNoSecretValue = errors.New("no resolved secret value for field")` and implement `RevealSecret`: find the component by id-or-name (same precedence as `Get`), `ParseRefs` its document, look up `field`, `Resolve`, and return the value only when `Status == secrets.StatusResolved` — otherwise `ErrNoSecretValue`.

**Do not add the value to any other response.** The `TestSecretValuesNeverSerialized` guard from Task 7 must still pass.

- [ ] **Step 4: Run tests**

Run: `go test -tags unit ./pkg/server ./pkg/resources -v 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `make test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/server/ pkg/resources/ cmd/serve.go
git commit -m "feat(server): loopback-only endpoint to reveal one secret value"
```

---

### Task 9: Name the secret in state-store connection failures

**Files:**
- Modify: `cmd/reconciler.go` (`Stores()`, `componentForEntry`)
- Modify: `pkg/server/workflows.go` (`StoreInfo`)
- Modify: `web/src/types/workflow.ts`
- Modify: `web/src/components/StateStoreConnectionsPanel.tsx`
- Test: `cmd/reconciler_secret_issue_test.go`, `web/src/components/StateStoreConnectionsPanel.test.tsx`

**Interfaces:**
- Consumes: `resolveComponentSecrets` from Task 6.
- Produces: `server.StoreInfo.SecretIssue string` (JSON `secretIssue`) and the matching optional `secretIssue?: string` on the TS `StateStore`.

- [ ] **Step 1: Write the failing Go test**

Create `cmd/reconciler_secret_issue_test.go`:

```go
//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

func TestResolveComponentSecretsReportsFirstIssue(t *testing.T) {
	dir := t.TempDir()
	writeFixtureStore(t, dir) // helper: secretstore.yaml + secrets.json {"redis":{"password":"v"}}
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
```

Write `writeFixtureStore` in the same file (a `t.Helper()` that writes the two files with `os.WriteFile`) rather than reaching into another package's test fixtures.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./cmd -run ResolveComponentSecrets -v`
Expected: FAIL until `writeFixtureStore` exists; the assertions themselves should then pass, since Task 6 built the helper. If they pass immediately, keep the test — it pins behaviour Task 9's UI depends on.

- [ ] **Step 3: Thread the issue to the API**

Add to `pkg/server/workflows.go`'s `StoreInfo`:

```go
	// SecretIssue names an unresolved secret reference that will make this
	// store fail to connect. Empty when there is none.
	SecretIssue string `json:"secretIssue,omitempty"`
```

In `cmd/reconciler.go`, make `componentForEntry` return the issue alongside the component (or store it on a small struct) and populate `SecretIssue` in `Stores()`.

- [ ] **Step 4: Write the failing web test**

Add to `web/src/components/StateStoreConnectionsPanel.test.tsx`:

```tsx
it('shows the secret issue for a store that cannot resolve its refs', async () => {
  mockStores([
    {
      id: 'a', name: 'statestore', type: 'state.redis', source: 'auto',
      path: '/tmp/statestore.yaml', active: false, connection: 'localhost:6379',
      secretIssue: 'redisPassword unresolved (key-not-found): secrets file /tmp/secrets.json',
    },
  ])
  render(<StateStoreConnectionsPanel />)
  expect(await screen.findByText(/redisPassword unresolved/)).toBeInTheDocument()
})
```

Use whatever store-mocking helper the existing tests in that file already use; do not introduce a second mocking style.

- [ ] **Step 5: Implement the UI**

Add `secretIssue?: string` to the `StateStore` interface in `web/src/types/workflow.ts`, and render it in the panel row, directly under the existing `s.path` line:

```tsx
{s.secretIssue && (
  <div className="field-err" style={{ fontSize: 11 }}>
    {s.secretIssue}
  </div>
)}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `make test && make build`
Expected: PASS, no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: name the unresolved secret when a state store cannot connect"
```

---

### Task 10: Web types, status pill, and styles

**Files:**
- Modify: `web/src/types/resources.ts`
- Create: `web/src/components/SecretStatusPill.tsx`
- Modify: `web/src/styles/theme.css`
- Modify: `web/STYLEGUIDE.md`
- Test: `web/src/components/SecretStatusPill.test.tsx`

**Interfaces:**
- Consumes: the JSON shapes from Task 7.
- Produces: `SecretRefStatus`, `SecretStoreInfo`, `SecretStatus` types; `<SecretStatusPill status={...} />`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/SecretStatusPill.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SecretStatusPill } from './SecretStatusPill'

describe('SecretStatusPill', () => {
  it('renders a resolved status as a success pill', () => {
    render(<SecretStatusPill status="resolved" />)
    const pill = screen.getByText('RESOLVED')
    expect(pill).toHaveClass('pill', 'secref-ok')
  })

  it('renders a hard failure as an error pill', () => {
    render(<SecretStatusPill status="key-not-found" />)
    expect(screen.getByText('KEY NOT FOUND')).toHaveClass('pill', 'secref-err')
  })

  it('renders a soft problem as a warning pill', () => {
    render(<SecretStatusPill status="empty-value" />)
    expect(screen.getByText('EMPTY VALUE')).toHaveClass('pill', 'secref-warn')
  })

  it('falls back to a warning pill for an unknown status', () => {
    render(<SecretStatusPill status={'something-new' as never} />)
    expect(screen.getByText('SOMETHING NEW')).toHaveClass('pill', 'secref-warn')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/SecretStatusPill.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Add to `web/src/types/resources.ts`:

```ts
export type SecretStatus =
  | 'resolved'
  | 'store-not-specified'
  | 'store-not-found'
  | 'store-unsupported'
  | 'store-unreadable'
  | 'key-not-found'
  | 'empty-value'
  | 'forbidden'

export interface SecretRefStatus {
  field: string
  kind: 'secretKeyRef' | 'envRef'
  store?: string
  name?: string
  key?: string
  status: SecretStatus
  detail?: string
}

export interface SecretStoreInfo {
  name: string
  type: string
  file?: string
  prefix?: string
  keys?: string[]
  keysCapped?: boolean
  initErr?: string
  usedBy?: string[]
}
```

and extend the existing interfaces:

```ts
export interface ResourceSummary {
  // …existing fields…
  secretRefs?: SecretRefStatus[]
}

export interface ResourceDetail extends ResourceSummary {
  raw?: string
  secretStore?: SecretStoreInfo
}
```

Create `web/src/components/SecretStatusPill.tsx`:

```tsx
import type { SecretStatus } from '../types/resources'

// Class tokens are prefixed with the component's own name so they cannot
// collide with unrelated global rules — see web/STYLEGUIDE.md.
const STATUS_CLASS: Record<SecretStatus, string> = {
  resolved: 'secref-ok',
  'store-not-specified': 'secref-err',
  'store-not-found': 'secref-err',
  'store-unsupported': 'secref-warn',
  'store-unreadable': 'secref-err',
  'key-not-found': 'secref-err',
  'empty-value': 'secref-warn',
  forbidden: 'secref-warn',
}

export function SecretStatusPill({ status }: { status: SecretStatus }) {
  const cls = STATUS_CLASS[status] ?? 'secref-warn'
  return (
    <span data-cy="secret-status-pill" className={'pill ' + cls}>
      {status.replace(/-/g, ' ').toUpperCase()}
    </span>
  )
}
```

Add to `web/src/styles/theme.css`, immediately after the `.s-pend` rule:

```css
.secref-ok { background: var(--done-bg); color: var(--done-fg); }
.secref-warn { background: var(--pend-bg); color: var(--pend-fg); }
.secref-err { background: var(--fail-bg); color: var(--fail-fg); }
```

In `web/STYLEGUIDE.md`, add `.pill .secref-*` to the component-vocabulary list next to the existing `.pill .s-*` entry, noting it is for secret reference status and rendered via `SecretStatusPill`.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/components/SecretStatusPill.test.tsx && npx vitest run src/test/styleguide.test.ts`
Expected: PASS both — the styleguide guard confirms no raw hex was introduced.

- [ ] **Step 5: Typecheck**

Run: `make build`
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/types/resources.ts web/src/components/SecretStatusPill.tsx web/src/components/SecretStatusPill.test.tsx web/src/styles/theme.css web/STYLEGUIDE.md
git commit -m "feat(web): secret status types, pill component, and tokens"
```

---

### Task 11: Secret references panel with masked reveal

**Files:**
- Create: `web/src/components/SecretRefsPanel.tsx`
- Create: `web/src/hooks/useSecretReveal.ts`
- Modify: `web/src/pages/ResourceDetail.tsx`
- Test: `web/src/components/SecretRefsPanel.test.tsx`

**Interfaces:**
- Consumes: `SecretRefStatus`, `SecretStatusPill` (Task 10); `POST /api/resources/component/{id}/secret-value` (Task 8); `getCapabilities().secretReveal`.
- Produces: `<SecretRefsPanel resourceId={string} refs={SecretRefStatus[]} />`.

Add `secretReveal?: boolean` to the `Capabilities` interface in `web/src/lib/capabilities.ts` and `secretReveal: true` to its `FULL` constant.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/SecretRefsPanel.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SecretRefsPanel } from './SecretRefsPanel'
import type { SecretRefStatus } from '../types/resources'

const resolved: SecretRefStatus = {
  field: 'redisPassword', kind: 'secretKeyRef', store: 'localsecretstore',
  name: 'redis:password', status: 'resolved', detail: 'secrets file /tmp/secrets.json',
}
const missing: SecretRefStatus = {
  field: 'apiKey', kind: 'secretKeyRef', store: 'localsecretstore',
  name: 'absent', status: 'key-not-found', detail: 'secrets file /tmp/secrets.json',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: 's3cr3t' }), { status: 200 })))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('SecretRefsPanel', () => {
  it('masks resolved values and names the store', () => {
    render(<SecretRefsPanel resourceId="abc" refs={[resolved]} />)
    expect(screen.getByText('redisPassword')).toBeInTheDocument()
    expect(screen.getByText('••••••••')).toBeInTheDocument()
    expect(screen.getByText(/localsecretstore/)).toBeInTheDocument()
    expect(screen.queryByText('s3cr3t')).not.toBeInTheDocument()
  })

  it('shows the failure detail for an unresolved ref', () => {
    render(<SecretRefsPanel resourceId="abc" refs={[missing]} />)
    expect(screen.getByText('KEY NOT FOUND')).toBeInTheDocument()
    expect(screen.getByText(/secrets file \/tmp\/secrets.json/)).toBeInTheDocument()
  })

  it('reveals a value on demand and re-masks it after 30 seconds', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<SecretRefsPanel resourceId="abc" refs={[resolved]} />)

    await user.click(screen.getByRole('button', { name: /reveal redisPassword/i }))
    await waitFor(() => expect(screen.getByText('s3cr3t')).toBeInTheDocument())

    vi.advanceTimersByTime(30_000)
    await waitFor(() => expect(screen.queryByText('s3cr3t')).not.toBeInTheDocument())
    expect(screen.getByText('••••••••')).toBeInTheDocument()
  })

  it('offers no reveal control for an unresolved ref', () => {
    render(<SecretRefsPanel resourceId="abc" refs={[missing]} />)
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument()
  })

  it('disables reveal when the server has it switched off', () => {
    vi.stubGlobal('window', Object.assign(window, {
      __DASH_CAPABILITIES__: { lifecycle: true, controlPlane: true, logs: true, workflows: true, secretReveal: false },
    }))
    render(<SecretRefsPanel resourceId="abc" refs={[resolved]} />)
    expect(screen.getByRole('button', { name: /reveal redisPassword/i })).toBeDisabled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/SecretRefsPanel.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/hooks/useSecretReveal.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl } from '../lib/api'

/** How long a revealed value stays visible. The dashboard is screen-shared. */
export const REVEAL_TTL_MS = 30_000

export function useSecretReveal(resourceId: string) {
  const [values, setValues] = useState<Record<string, string>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const clearAll = useCallback(() => {
    Object.values(timers.current).forEach(clearTimeout)
    timers.current = {}
    setValues({})
  }, [])

  // Never let a revealed value outlive the pane it belongs to.
  useEffect(() => clearAll, [clearAll, resourceId])

  const hide = useCallback((field: string) => {
    clearTimeout(timers.current[field])
    delete timers.current[field]
    setValues((v) => {
      const next = { ...v }
      delete next[field]
      return next
    })
  }, [])

  const reveal = useCallback(
    async (field: string) => {
      const res = await fetch(apiUrl(`/resources/component/${encodeURIComponent(resourceId)}/secret-value`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field }),
      })
      if (!res.ok) throw new Error(`could not reveal ${field}: ${res.status}`)
      const body = (await res.json()) as { value: string }
      setValues((v) => ({ ...v, [field]: body.value }))
      timers.current[field] = setTimeout(() => hide(field), REVEAL_TTL_MS)
    },
    [resourceId, hide],
  )

  return { values, reveal, hide }
}
```

Create `web/src/components/SecretRefsPanel.tsx`:

```tsx
import { SecretStatusPill } from './SecretStatusPill'
import { useSecretReveal } from '../hooks/useSecretReveal'
import { getCapabilities } from '../lib/capabilities'
import { trackAction } from '../lib/telemetry'
import type { SecretRefStatus } from '../types/resources'

interface Props {
  resourceId: string
  refs: SecretRefStatus[]
  /** Component type, for telemetry. Never the name — that can be identifying. */
  componentType?: string
}

export function SecretRefsPanel({ resourceId, refs, componentType }: Props) {
  const { values, reveal, hide } = useSecretReveal(resourceId)
  const revealAllowed = getCapabilities().secretReveal !== false
  const store = refs.find((r) => r.store)?.store

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="ph">
        Secret references
        {store && (
          <span className="mono" style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)' }}>
            via {store}
          </span>
        )}
      </div>
      <div className="kv">
        {refs.map((r) => {
          const shown = values[r.field]
          const isResolved = r.status === 'resolved'
          return (
            <>
              <div key={`${r.field}-k`} className="kk">{r.field}</div>
              <div key={`${r.field}-v`} className="vv" style={{ flexWrap: 'wrap', gap: 8 }}>
                <SecretStatusPill status={r.status} />
                <span className="mono" style={{ fontSize: 12 }}>
                  {r.kind === 'envRef' ? `env ${r.name}` : `${r.store ?? '—'} → ${r.key || r.name}`}
                </span>
                {isResolved && (
                  <>
                    <span className="mono" style={{ fontSize: 12 }}>{shown ?? '••••••••'}</span>
                    <button
                      className="btn"
                      aria-label={shown ? `hide ${r.field}` : `reveal ${r.field}`}
                      aria-pressed={!!shown}
                      disabled={!revealAllowed}
                      title={revealAllowed ? undefined : 'Reveal is unavailable when the dashboard is served off-host'}
                      onClick={() => {
                        if (shown) return hide(r.field)
                        trackAction('secret_reveal', { componentType: componentType ?? '' })
                        void reveal(r.field)
                      }}
                    >
                      {shown ? 'Hide' : 'Reveal'}
                    </button>
                  </>
                )}
                {!isResolved && r.detail && (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.detail}</span>
                )}
              </div>
            </>
          )
        })}
      </div>
    </div>
  )
}
```

Replace the `<>…</>` fragments with `<Fragment key={r.field}>` (imported from `react`) so React gets one stable key per row rather than two — the paired-`<div>` shape is what `.kv`'s two-column grid requires.

In `ResourceDetail.tsx`, render it above the `<pre className="code">`:

```tsx
{kind === 'component' && (detail.secretRefs?.length ?? 0) > 0 && (
  <SecretRefsPanel resourceId={detail.id} refs={detail.secretRefs!} componentType={detail.type} />
)}
```

Check `web/src/lib/telemetry.ts` for `trackAction`'s exact signature before using it; match it rather than assuming.

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/components/SecretRefsPanel.test.tsx src/pages/ResourceDetail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and full gate**

Run: `make build && make test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SecretRefsPanel.tsx web/src/components/SecretRefsPanel.test.tsx web/src/hooks/useSecretReveal.ts web/src/pages/ResourceDetail.tsx web/src/lib/capabilities.ts
git commit -m "feat(web): secret references panel with masked per-field reveal"
```

---

### Task 12: Secret store panel and the list-rail marker

**Files:**
- Create: `web/src/components/SecretStorePanel.tsx`
- Modify: `web/src/pages/ResourceDetail.tsx`
- Modify: `web/src/pages/ResourceList.tsx`
- Test: `web/src/components/SecretStorePanel.test.tsx`, `web/src/pages/ResourceList.test.tsx`

**Interfaces:**
- Consumes: `SecretStoreInfo` (Task 10), `ResourceSummary.secretRefs` (Task 10).
- Produces: `<SecretStorePanel info={SecretStoreInfo} />`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/SecretStorePanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { SecretStorePanel } from './SecretStorePanel'

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe('SecretStorePanel', () => {
  it('shows the resolved file and the flattened key names', () => {
    wrap(<SecretStorePanel info={{
      name: 'localsecretstore', type: 'secretstores.local.file',
      file: '/tmp/secrets.json', keys: ['redis:password', 'apiKey'], usedBy: ['statestore'],
    }} />)
    expect(screen.getByText('/tmp/secrets.json')).toBeInTheDocument()
    expect(screen.getByText('redis:password')).toBeInTheDocument()
    expect(screen.getByText('statestore')).toBeInTheDocument()
  })

  it('reports an init failure instead of an empty key list', () => {
    wrap(<SecretStorePanel info={{
      name: 's', type: 'secretstores.local.file',
      file: '/tmp/missing.json', initErr: 'open /tmp/missing.json: no such file or directory',
    }} />)
    expect(screen.getByText(/no such file or directory/)).toBeInTheDocument()
  })

  it('says why keys are not listed for a prefix-less env store', () => {
    wrap(<SecretStorePanel info={{ name: 'envsecrets', type: 'secretstores.local.env' }} />)
    expect(screen.getByText(/set a prefix/i)).toBeInTheDocument()
  })

  it('lists env keys when a prefix is set', () => {
    wrap(<SecretStorePanel info={{
      name: 'envsecrets', type: 'secretstores.local.env', prefix: 'MYAPP_', keys: ['ONE'],
    }} />)
    expect(screen.getByText('ONE')).toBeInTheDocument()
    expect(screen.getByText(/MYAPP_/)).toBeInTheDocument()
  })

  it('states the cap rather than truncating silently', () => {
    wrap(<SecretStorePanel info={{
      name: 's', type: 'secretstores.local.file', file: '/tmp/s.json',
      keys: ['a'], keysCapped: true,
    }} />)
    expect(screen.getByText(/more/i)).toBeInTheDocument()
  })
})
```

Add to `web/src/pages/ResourceList.test.tsx`:

```tsx
it('marks components whose secret references do not resolve', async () => {
  mockResources([
    { id: '1', name: 'statestore', kind: 'component', type: 'state.redis', path: '/tmp/a.yaml',
      secretRefs: [{ field: 'redisPassword', kind: 'secretKeyRef', status: 'key-not-found' }] },
    { id: '2', name: 'pubsub', kind: 'component', type: 'pubsub.redis', path: '/tmp/b.yaml' },
  ])
  renderList()
  expect(await screen.findByLabelText(/statestore has an unresolved secret/i)).toBeInTheDocument()
  expect(screen.queryByLabelText(/pubsub has an unresolved secret/i)).not.toBeInTheDocument()
})
```

Use the mocking helpers already present in that test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/SecretStorePanel.test.tsx src/pages/ResourceList.test.tsx`
Expected: FAIL — module not found; no marker rendered.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/components/SecretStorePanel.tsx`:

```tsx
import { Link } from 'react-router-dom'
import type { SecretStoreInfo } from '../types/resources'

export function SecretStorePanel({ info }: { info: SecretStoreInfo }) {
  const isEnv = info.type === 'secretstores.local.env'
  const noPrefix = isEnv && !info.prefix

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="ph">Secret store</div>
      <div className="kv">
        {!isEnv && (
          <>
            <div className="kk">Secrets file</div>
            <div className="vv mono">{info.file || '—'}</div>
          </>
        )}
        {isEnv && (
          <>
            <div className="kk">Prefix</div>
            <div className="vv mono">{info.prefix || '(none)'}</div>
          </>
        )}
        {info.initErr && (
          <>
            <div className="kk">Error</div>
            <div className="vv"><span className="field-err">{info.initErr}</span></div>
          </>
        )}
        <div className="kk">Keys</div>
        <div className="vv" style={{ flexWrap: 'wrap', gap: 6 }}>
          {noPrefix ? (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              Set a prefix on this store to list its keys — without one, every environment
              variable would be listed.
            </span>
          ) : info.keys?.length ? (
            <>
              {info.keys.map((k) => <span key={k} className="chip mono">{k}</span>)}
              {info.keysCapped && (
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  …and more (list capped at 200)
                </span>
              )}
            </>
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>No keys found.</span>
          )}
        </div>
        {isEnv && (
          <>
            <div className="kk">Source</div>
            <div className="vv" style={{ fontSize: 12, color: 'var(--muted)' }}>
              Read from the dashboard's own environment, which may differ from your app's.
              DAPR_* and APP_API_TOKEN are never readable.
            </div>
          </>
        )}
        <div className="kk">Referenced by</div>
        <div className="vv" style={{ flexWrap: 'wrap', gap: 6 }}>
          {info.usedBy?.length ? (
            info.usedBy.map((n) => (
              <Link key={n} className="appref link" to={`/components/${encodeURIComponent(n)}`}>{n}</Link>
            ))
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>No components reference this store.</span>
          )}
        </div>
      </div>
    </div>
  )
}
```

In `ResourceDetail.tsx`, render it above `SecretRefsPanel`:

```tsx
{detail.secretStore && <SecretStorePanel info={detail.secretStore} />}
```

In `ResourceList.tsx`, inside the row map, after the `<span className="cn">` element:

```tsx
{resource.secretRefs?.some((r) => r.status !== 'resolved') && (
  <span
    className="cn-secretwarn"
    aria-label={`${resource.name} has an unresolved secret reference`}
    title="Unresolved secret reference"
  >
    ⚠
  </span>
)}
```

Add to `web/src/styles/theme.css` next to the `.secref-*` rules:

```css
.cn-secretwarn { color: var(--fail-fg); font-size: 11px; }
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run`
Expected: PASS (whole web suite, including the styleguide guard).

- [ ] **Step 5: Typecheck and full gate**

Run: `make build && make test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/SecretStorePanel.tsx web/src/components/SecretStorePanel.test.tsx web/src/pages/ResourceDetail.tsx web/src/pages/ResourceList.tsx web/src/pages/ResourceList.test.tsx web/src/styles/theme.css
git commit -m "feat(web): secret store detail panel and unresolved-ref marker"
```

---

### Task 13: End-to-end integration test and documentation

**Files:**
- Create: `pkg/server/secrets_integration_test.go`
- Modify: `ARCHITECTURE.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: everything from Tasks 1–12.
- Produces: no new code interfaces.

- [ ] **Step 1: Write the failing integration test**

Create `pkg/server/secrets_integration_test.go`:

```go
//go:build integration

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/secrets"
	"github.com/stretchr/testify/require"
)

func TestSecretReferencesEndToEnd(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secretstore.yaml"), []byte(`apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: localsecretstore
spec:
  type: secretstores.local.file
  metadata:
  - name: secretsFile
    value: secrets.json
`), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(`apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  metadata:
  - name: redisPassword
    secretKeyRef:
      name: redis:password
auth:
  secretStore: localsecretstore
`), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "secrets.json"),
		[]byte(`{"redis":{"password":"s3cr3t"}}`), 0o600))

	paths := func() []string { return []string{dir} }
	res := resources.New(paths, nil, resources.WithSecrets(secrets.New(paths)))
	h := NewRouter(Options{DistFS: emptyFS(t), Resources: res, ListenPort: 9090})

	// The list reports status and leaks nothing.
	req := httptest.NewRequest(http.MethodGet, "/api/resources?kind=component", nil)
	req.Host = "127.0.0.1:9090"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"status":"resolved"`)
	require.NotContains(t, rec.Body.String(), "s3cr3t")

	var list []resources.Resource
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &list))
	var id string
	for _, r := range list {
		if r.Name == "statestore" {
			id = r.ID
		}
	}
	require.NotEmpty(t, id)

	// The reveal endpoint is the only path that returns the value.
	req = httptest.NewRequest(http.MethodPost,
		"/api/resources/component/"+id+"/secret-value", strings.NewReader(`{"field":"redisPassword"}`))
	req.Host = "127.0.0.1:9090"
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "s3cr3t")
}
```

If `emptyFS` is not available in the `integration` build, copy the helper used by the other integration tests in `pkg/server`.

- [ ] **Step 2: Run it**

Run: `go test -tags integration ./pkg/server -run TestSecretReferencesEndToEnd -v`
Expected: PASS.

- [ ] **Step 3: Update the documentation**

In `ARCHITECTURE.md`, add `pkg/secrets` to the repository-layout block in section 2:

```
  secrets/              local secret-store detection + secretKeyRef/envRef resolution,
                        delegating to components-contrib's own local.file / local.env
                        stores; feeds pkg/resources and cmd/reconciler
```

In the same file's mental-model list, note that component secret references are resolved for display and for state-store connections, and that resolution uses the dashboard's own environment and working directory — not daprd's.

In `AGENTS.md`, add `secrets/` to the `pkg/` listing with a one-line description matching the above.

- [ ] **Step 4: Full gate**

Run: `make test && make test-integration && make build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/server/secrets_integration_test.go ARCHITECTURE.md AGENTS.md
git commit -m "test: end-to-end secret reference coverage; docs: pkg/secrets"
```

---

## Done criteria

- `make test`, `make test-integration`, and `make build` all pass.
- `grep -rn "DetectSecretStores\|ResolveSecrets" cmd pkg --include="*.go"` returns nothing.
- `git diff --exit-code go.mod` after `go mod tidy` — no new modules.
- A component with `secretKeyRef: {name: redis:password}` against a `local.file` store shows `RESOLVED` on the Components page, and its value is visible only after clicking Reveal.
- Issue #94's first two acceptance criteria are met; the third needs no work (see the spec).
