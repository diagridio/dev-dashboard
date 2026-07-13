# MongoDB State-Store Support + Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MongoDB as a supported state store for inspecting Dapr workflow state, and add integration tests that hold all four supported backends (Redis, SQLite, PostgreSQL, MongoDB) to the same observable contract.

**Architecture:** MongoDB in `components-contrib` v1.18.0 already implements the `state.KeysLiker` and `io.Closer` interfaces the dashboard's `Store` surface needs, so the change is additive: a new switch case in the connector, matching entries in the display/translation helpers and allowlists, a frontend type + field wiring, and a `testcontainers-go`-based integration harness that replaces the in-process miniredis test.

**Tech Stack:** Go 1.26, `github.com/dapr/components-contrib` v1.18.0, `github.com/testcontainers/testcontainers-go` (new), React + TypeScript + Vitest (`web/`).

## Global Constraints

- Component-type strings are exact: `state.redis`, `state.sqlite`, `state.postgresql` (alias `state.postgres`), `state.mongodb`.
- `ConnInfo` output MUST NEVER contain credentials (username/password) — same discipline as the existing Postgres case.
- Integration tests live under the `//go:build integration` tag and MUST `t.Skip()` (not fail) when Docker is unavailable.
- Backend allowlist (`pkg/server/api.go`), connector (`pkg/statestore/store.go`), and frontend list (`web/src/lib/storeTypes.ts`) MUST stay in sync — all four types present in each.
- Follow existing patterns; do not restructure unrelated code. DRY, YAGNI, TDD, frequent commits.
- **Prerequisite (Task 5 only):** `testcontainers-go` is not yet in the module cache or `go.sum`; Task 5's first step requires network access to `go get` it and a running Docker daemon to actually exercise (not skip) the container tests.

---

## File Structure

**Backend (Go)**
- `pkg/statestore/store.go` — add MongoDB connector case + import (modify)
- `pkg/statestore/conninfo.go` — add MongoDB display summary (modify)
- `pkg/statestore/translate.go` — add MongoDB host translation (modify)
- `pkg/server/api.go` — add MongoDB to allowlist (modify)
- `pkg/statestore/conninfo_test.go` — MongoDB unit cases (modify)
- `pkg/statestore/translate_test.go` — MongoDB unit cases (modify)
- `pkg/server/statestores_test.go` — allowlist acceptance case (modify)
- `pkg/statestore/store_integration_test.go` — shared contract helper + 4 backends (rewrite)
- `go.mod` / `go.sum` — testcontainers-go + modules (modify)

**Frontend (TypeScript)**
- `web/src/lib/storeTypes.ts` — type + label (modify)
- `web/src/hooks/useComponentCatalog.ts` — synthetic `host` + required `databaseName` (modify)
- `web/src/lib/storeTypes.test.ts` — label/type coverage (create or modify)
- `web/src/components/StateStoreConnectionDialog.test.tsx` — MongoDB dropdown + required-field gating (modify)

---

## Task 1: Frontend — expose MongoDB in the supported list and dialog

**Files:**
- Modify: `web/src/lib/storeTypes.ts`
- Modify: `web/src/hooks/useComponentCatalog.ts`
- Test: `web/src/lib/storeTypes.test.ts` (create if absent)
- Test: `web/src/components/StateStoreConnectionDialog.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `SUPPORTED_STORE_TYPES` now includes `'state.mongodb'`; `storeTypeLabel('state.mongodb') === 'MongoDB'`; `fieldsFor('state.mongodb')` returns a list whose `host` and `databaseName` fields have `required: true`.

- [ ] **Step 1: Write the failing test for storeTypes**

Add to `web/src/lib/storeTypes.test.ts` (create the file if it does not exist; use the existing import style from other `web/src/lib/*.test.ts` files):

```ts
import { describe, it, expect } from 'vitest'
import { SUPPORTED_STORE_TYPES, storeTypeLabel, implFor } from './storeTypes'

describe('storeTypes', () => {
  it('includes MongoDB in the supported set', () => {
    expect(SUPPORTED_STORE_TYPES).toContain('state.mongodb')
  })

  it('labels MongoDB', () => {
    expect(storeTypeLabel('state.mongodb')).toBe('MongoDB')
  })

  it('maps state.mongodb to the mongodb catalog name', () => {
    expect(implFor('state.mongodb')).toBe('mongodb')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/lib/storeTypes.test.ts`
Expected: FAIL — `SUPPORTED_STORE_TYPES` does not contain `'state.mongodb'`; label is `'state.mongodb'` not `'MongoDB'`.

- [ ] **Step 3: Add the type and label**

In `web/src/lib/storeTypes.ts`, extend the array and label map:

```ts
export const SUPPORTED_STORE_TYPES = ['state.redis', 'state.sqlite', 'state.postgresql', 'state.mongodb'] as const

const LABELS: Record<string, string> = {
  'state.redis': 'Redis',
  'state.sqlite': 'SQLite',
  'state.postgresql': 'PostgreSQL',
  'state.mongodb': 'MongoDB',
}
```

- [ ] **Step 4: Run the storeTypes test to verify it passes**

Run: `cd web && npx vitest run src/lib/storeTypes.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the dialog's MongoDB required fields**

In `web/src/components/StateStoreConnectionDialog.test.tsx`, add a test asserting MongoDB is selectable and that `host` + `databaseName` are rendered as required. Match the existing test setup in that file (it already mocks `useComponentCatalog` / `useStoreMutations` — reuse that harness; if the existing mock hard-codes `fieldsFor`, extend the mock to return the MongoDB fields below when called with `'state.mongodb'`):

```tsx
it('marks host and databaseName required for MongoDB', () => {
  // The catalog mock must return these for fieldsFor('state.mongodb'):
  //   [{ name: 'host', required: true, type: 'string' },
  //    { name: 'databaseName', required: true, type: 'string' },
  //    { name: 'collectionName', required: false, type: 'string' }]
  render(<StateStoreConnectionDialog open onClose={() => {}} onSaved={() => {}} />)
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'state.mongodb' } })

  // Required section shows host and databaseName with the required marker.
  expect(screen.getByText('host')).toBeInTheDocument()
  expect(screen.getByText('databaseName')).toBeInTheDocument()

  // Save is disabled until name + required fields are filled.
  expect(screen.getByRole('button', { name: /save connection/i })).toBeDisabled()
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd web && npx vitest run src/components/StateStoreConnectionDialog.test.tsx`
Expected: FAIL — MongoDB not in dropdown / required fields not marked (depending on the mock).

- [ ] **Step 7: Implement synthetic `host` + required `databaseName` in the catalog hook**

In `web/src/hooks/useComponentCatalog.ts`, add a MongoDB synthetic field and a required-override map, and apply the override in `fieldsFor`:

```ts
const SYNTHETIC_REQUIRED: Record<string, MetadataField> = {
  'state.postgresql': {
    name: 'connectionString',
    type: 'string',
    required: true,
    sensitive: true,
    description: 'PostgreSQL connection string',
  },
  'state.sqlite': {
    name: 'connectionString',
    type: 'string',
    required: true,
    description: 'Path or DSN of the SQLite database file',
  },
  // host/server live in the connection profile the catalog omits, so inject
  // host as a synthetic required field (host:port, e.g. localhost:27017).
  'state.mongodb': {
    name: 'host',
    type: 'string',
    required: true,
    description: 'MongoDB host as host:port (e.g. localhost:27017)',
  },
}

// Base catalog fields to promote to required (present in the schema but not
// flagged required there). MongoDB defaults databaseName to "daprStore", but
// inspecting a workflow store requires pointing at the app's actual database.
const REQUIRED_OVERRIDES: Record<string, string[]> = {
  'state.mongodb': ['databaseName'],
}
```

Then update `fieldsFor`:

```ts
  const fieldsFor = useCallback((type: string): MetadataField[] => {
    const name = implFor(type)
    const matches = schemas.filter((s) => s.name === name)
    const chosen = matches.find((s) => s.status === 'stable') ?? matches[0]
    const overrides = REQUIRED_OVERRIDES[type] ?? []
    const base = (chosen?.metadata ?? []).map((f) =>
      overrides.includes(f.name) ? { ...f, required: true } : f,
    )
    const synthetic = SYNTHETIC_REQUIRED[type]
    if (synthetic && !base.some((f) => f.name === synthetic.name)) {
      return [synthetic, ...base]
    }
    return base
  }, [schemas])
```

- [ ] **Step 8: Run the dialog + lib tests to verify they pass**

Run: `cd web && npx vitest run src/components/StateStoreConnectionDialog.test.tsx src/lib/storeTypes.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full web test + typecheck to confirm no regressions**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: PASS (including the existing `src/test/styleguide.test.ts`; if it flags the new "MongoDB" label, add it to that test's allowlist as the file's convention dictates).

- [ ] **Step 10: Commit**

```bash
git add web/src/lib/storeTypes.ts web/src/lib/storeTypes.test.ts web/src/hooks/useComponentCatalog.ts web/src/components/StateStoreConnectionDialog.test.tsx
git commit -m "feat(web): expose MongoDB state store in supported list and connection dialog"
```

---

## Task 2: Backend — add MongoDB to the API allowlist

**Files:**
- Modify: `pkg/server/api.go:152-156`
- Test: `pkg/server/statestores_test.go`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `validateStoreBody` accepts `{type: "state.mongodb", ...}`; the `POST /statestores` handler no longer rejects MongoDB as unsupported.

- [ ] **Step 1: Write the failing test**

Add to `pkg/server/statestores_test.go` (mirror the existing Postgres acceptance test around line 83):

```go
func TestPostStore_AcceptsMongoDB(t *testing.T) {
	reg := &fakeRegistry{}
	h := newTestHandler(t, reg) // use whatever constructor the sibling tests use
	res, _ := postJSON(t, h, "/statestores",
		`{"name":"mongo","type":"state.mongodb","metadata":{"host":"localhost:27017","databaseName":"daprStore"}}`)
	require.Equal(t, http.StatusCreated, res.Code)
	require.Len(t, reg.added, 1)
	require.Equal(t, "state.mongodb", reg.added[0].Type)
}
```

Note: match the exact helper names (`newTestHandler`, `postJSON`, `fakeRegistry`, expected status code) used by the neighboring tests in this file — copy their shape rather than the illustrative names above.

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./pkg/server/ -run TestPostStore_AcceptsMongoDB -v`
Expected: FAIL — validation rejects `state.mongodb` (unsupported type), status is 400 not 201.

- [ ] **Step 3: Add MongoDB to the allowlist**

In `pkg/server/api.go`, extend `supportedStoreTypes`:

```go
var supportedStoreTypes = map[string]bool{
	"state.redis":      true,
	"state.sqlite":     true,
	"state.postgresql": true,
	"state.mongodb":    true,
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/server/ -run TestPostStore_AcceptsMongoDB -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/server/api.go pkg/server/statestores_test.go
git commit -m "feat(server): accept state.mongodb in the connection allowlist"
```

---

## Task 3: Backend — MongoDB connection-info summary (no credentials)

**Files:**
- Modify: `pkg/statestore/conninfo.go`
- Test: `pkg/statestore/conninfo_test.go`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `ConnInfo(Component{Type: "state.mongodb", ...})` returns a credentials-free `host[/databaseName]` summary.

- [ ] **Step 1: Write the failing test**

Add to the table in `pkg/statestore/conninfo_test.go` (match the existing struct-literal test-case shape in that file):

```go
{
	name: "mongodb host and database",
	comp: Component{Type: "state.mongodb", Metadata: map[string]string{"host": "localhost:27017", "databaseName": "orders"}},
	want: "localhost:27017/orders",
},
{
	name: "mongodb uri strips credentials",
	comp: Component{Type: "state.mongodb", Metadata: map[string]string{"host": "mongodb://admin:s3cret@db:27017/orders"}},
	want: "db:27017/orders",
},
{
	name: "mongodb host only",
	comp: Component{Type: "state.mongodb", Metadata: map[string]string{"host": "localhost:27017"}},
	want: "localhost:27017",
},
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./pkg/statestore/ -run TestConnInfo -v`
Expected: FAIL — MongoDB returns `""` (falls through to the default case).

- [ ] **Step 3: Implement the MongoDB case**

In `pkg/statestore/conninfo.go`, add a case to the `ConnInfo` switch and a helper. Reuse the credential-stripping discipline of `pgConnInfo`:

```go
	case "state.mongodb":
		return mongoConnInfo(c.Metadata["host"], c.Metadata["databaseName"])
```

Add below `pgConnInfo`:

```go
// mongoConnInfo builds a credentials-free "host[:port][/dbname]" summary for a
// MongoDB component. The host field may be a bare "host:port" or a full
// mongodb:// URI; userinfo (user:password) is always discarded.
func mongoConnInfo(hostField, dbName string) string {
	hostField = strings.TrimSpace(hostField)
	if hostField == "" {
		return ""
	}
	host := hostField
	db := strings.TrimSpace(dbName)
	if strings.HasPrefix(hostField, "mongodb://") || strings.HasPrefix(hostField, "mongodb+srv://") {
		u, err := url.Parse(hostField)
		if err != nil {
			return ""
		}
		// SECURITY: u.Host is host[:port] only; Go's net/url keeps userinfo in
		// u.User, which we never read. Do not rebuild this from raw strings.
		host = u.Host
		if db == "" {
			db = strings.TrimPrefix(u.Path, "/")
		}
	}
	switch {
	case host != "" && db != "":
		return host + "/" + db
	default:
		return host
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/statestore/ -run TestConnInfo -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/statestore/conninfo.go pkg/statestore/conninfo_test.go
git commit -m "feat(statestore): credentials-free ConnInfo summary for MongoDB"
```

---

## Task 4: Backend — MongoDB compose-network host translation

**Files:**
- Modify: `pkg/statestore/translate.go`
- Test: `pkg/statestore/translate_test.go`

**Interfaces:**
- Consumes: `HostLookup` (existing type in this package).
- Produces: `Translate` rewrites the `host` field (host:port) for `state.mongodb` on a lookup hit; foreign hosts pass through unchanged.

- [ ] **Step 1: Write the failing test**

Add to `pkg/statestore/translate_test.go` (match the existing per-case test style in that file; reuse whatever `HostLookup` stub the sibling Redis/Postgres translate tests use):

```go
func TestTranslate_MongoHostRewrite(t *testing.T) {
	hosts := func(host string, port int) (string, bool) {
		if host == "mongo" && port == 27017 {
			return "127.0.0.1:55017", true
		}
		return "", false
	}
	c := Component{Type: "state.mongodb", Metadata: map[string]string{"host": "mongo:27017"}}
	got := Translate(c, hosts, nil)
	require.Equal(t, "127.0.0.1:55017", got.Metadata["host"])
}

func TestTranslate_MongoForeignHostPassthrough(t *testing.T) {
	hosts := func(string, int) (string, bool) { return "", false }
	c := Component{Type: "state.mongodb", Metadata: map[string]string{"host": "prod.example.com:27017"}}
	got := Translate(c, hosts, nil)
	require.Equal(t, "prod.example.com:27017", got.Metadata["host"])
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./pkg/statestore/ -run TestTranslate_Mongo -v`
Expected: FAIL — `host` is unchanged on the rewrite case (MongoDB has no branch in `Translate`).

- [ ] **Step 3: Implement the MongoDB case**

In `pkg/statestore/translate.go`, add a case to the `Translate` switch, mirroring the `state.redis` branch (which rewrites a `host:port` field):

```go
	case "state.mongodb":
		if hosts == nil {
			return c
		}
		// Only the bare host:port form is translatable. A mongodb:// URI or
		// mongodb+srv address passes through untouched (SRV has no host:port).
		host, portStr, ok := strings.Cut(c.Metadata["host"], ":")
		if !ok {
			return c
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return c
		}
		if translated, ok := hosts(host, port); ok {
			set("host", translated)
		}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/statestore/ -run TestTranslate_Mongo -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/statestore/translate.go pkg/statestore/translate_test.go
git commit -m "feat(statestore): compose host translation for MongoDB"
```

---

## Task 5: Integration harness — testcontainers-go, shared contract, SQLite/Redis/Postgres

**Files:**
- Modify: `go.mod`, `go.sum`
- Rewrite: `pkg/statestore/store_integration_test.go`

**Interfaces:**
- Consumes: existing `statestore.New`, `Store.Set/Keys/Get/Delete`, `SeedForTest`.
- Produces: a package-private `runStoreContract(t *testing.T, store statestore.Store)` helper used by every backend test (and by Task 6's MongoDB test).

- [ ] **Step 1: Add the testcontainers-go dependencies**

Requires network access. Run:

```bash
go get github.com/testcontainers/testcontainers-go@latest
go get github.com/testcontainers/testcontainers-go/modules/redis@latest
go get github.com/testcontainers/testcontainers-go/modules/postgres@latest
go get github.com/testcontainers/testcontainers-go/modules/mongodb@latest
```

- [ ] **Step 2: Rewrite the integration test file with the shared contract + SQLite/Redis/Postgres**

Replace the entire contents of `pkg/statestore/store_integration_test.go` (this removes the miniredis-based Redis test and its `INFO replication` pre-hook, replacing it with a real Redis container):

```go
//go:build integration

package statestore_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Real Dapr workflow key shape: <appId>||<actorType>||<instanceId>||<suffix>.
const (
	metaKey = "k||a||1||metadata"
	histKey = "k||a||1||history-000000"
	keyLike = "k||a||1||%"
)

// runStoreContract asserts the observable Store contract against a live backend:
// seed two keys, list them by LIKE pattern, round-trip a value, delete one.
func runStoreContract(t *testing.T, store statestore.Store) {
	t.Helper()
	ctx := context.Background()

	require.NoError(t, store.Set(ctx, metaKey, []byte("v1")))
	require.NoError(t, store.Set(ctx, histKey, []byte("v2")))

	keys, _, err := store.Keys(ctx, keyLike, "", 0)
	require.NoError(t, err)
	require.ElementsMatch(t, []string{metaKey, histKey}, keys)

	got, err := store.Get(ctx, metaKey)
	require.NoError(t, err)
	require.Equal(t, "v1", string(got))

	require.NoError(t, store.Delete(ctx, metaKey))
	keys, _, err = store.Keys(ctx, keyLike, "", 0)
	require.NoError(t, err)
	require.Equal(t, []string{histKey}, keys)
}

func TestSQLiteStoreContract(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "state.db")
	store, err := statestore.New(context.Background(), statestore.Component{
		Name:     "statestore",
		Type:     "state.sqlite",
		Version:  "v1",
		Metadata: map[string]string{"connectionString": dbPath},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	runStoreContract(t, store)
}

func TestRedisStoreContract(t *testing.T) {
	testcontainers.SkipIfProviderIsNotHealthy(t)
	ctx := context.Background()

	c, err := tcredis.Run(ctx, "redis:7")
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Terminate(ctx) })

	host, err := c.Host(ctx)
	require.NoError(t, err)
	port, err := c.MappedPort(ctx, "6379/tcp")
	require.NoError(t, err)

	store, err := statestore.New(ctx, statestore.Component{
		Name:     "statestore",
		Type:     "state.redis",
		Version:  "v1",
		Metadata: map[string]string{"redisHost": host + ":" + port.Port(), "redisPassword": ""},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	runStoreContract(t, store)
}

func TestPostgresStoreContract(t *testing.T) {
	testcontainers.SkipIfProviderIsNotHealthy(t)
	ctx := context.Background()

	c, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("dapr"),
		tcpostgres.WithUsername("dapr"),
		tcpostgres.WithPassword("dapr"),
		testcontainers.WithWaitStrategy(
			wait.ForListeningPort("5432/tcp"),
		),
	)
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Terminate(ctx) })

	cs, err := c.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)

	store, err := statestore.New(ctx, statestore.Component{
		Name:     "statestore",
		Type:     "state.postgresql",
		Version:  "v1",
		Metadata: map[string]string{"connectionString": cs},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	runStoreContract(t, store)
}
```

Note: `tcmongo` is imported here so the file compiles as the single integration file across Tasks 5 and 6. If executing Task 5 in isolation before Task 6, temporarily omit the `tcmongo` import to avoid an unused-import error, then re-add it in Task 6. (Subagent-driven execution should do Task 5 then Task 6 back-to-back.)

- [ ] **Step 3: Tidy modules**

Run: `go mod tidy`
Expected: `go.mod`/`go.sum` updated; testcontainers-go and the three modules promoted to direct requires.

- [ ] **Step 4: Verify the package compiles under the integration tag**

Run: `go build -tags integration ./pkg/statestore/`
Expected: no output (success). If `tcmongo` is unused at this point, see the note in Step 2.

- [ ] **Step 5: Run the integration tests (Docker required to exercise; otherwise they skip)**

Run: `go test -tags integration ./pkg/statestore/ -run 'TestSQLiteStoreContract|TestRedisStoreContract|TestPostgresStoreContract' -v`
Expected with Docker: PASS (3 tests). Expected without Docker: SQLite PASS, Redis + Postgres SKIP with a provider-not-healthy message. No FAIL in either case.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum pkg/statestore/store_integration_test.go
git commit -m "test(statestore): testcontainers integration harness for sqlite, redis, postgres"
```

---

## Task 6: Backend — MongoDB connector + MongoDB integration test

**Files:**
- Modify: `pkg/statestore/store.go`
- Modify: `pkg/statestore/store_integration_test.go`

**Interfaces:**
- Consumes: `runStoreContract` (Task 5), `testcontainers.SkipIfProviderIsNotHealthy`, `tcmongo` module.
- Produces: `statestore.New` returns a working `Store` for `state.mongodb`.

- [ ] **Step 1: Write the failing MongoDB integration test**

Append to `pkg/statestore/store_integration_test.go` (the `tcmongo` import is already present from Task 5):

```go
func TestMongoStoreContract(t *testing.T) {
	testcontainers.SkipIfProviderIsNotHealthy(t)
	ctx := context.Background()

	c, err := tcmongo.Run(ctx, "mongo:7")
	require.NoError(t, err)
	t.Cleanup(func() { _ = c.Terminate(ctx) })

	host, err := c.Host(ctx)
	require.NoError(t, err)
	port, err := c.MappedPort(ctx, "27017/tcp")
	require.NoError(t, err)

	store, err := statestore.New(ctx, statestore.Component{
		Name:    "statestore",
		Type:    "state.mongodb",
		Version: "v1",
		Metadata: map[string]string{
			"host":         host + ":" + port.Port(),
			"databaseName": "daprStore",
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	runStoreContract(t, store)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test -tags integration ./pkg/statestore/ -run TestMongoStoreContract -v`
Expected with Docker: FAIL — `statestore.New` returns `ErrUnsupported` for `state.mongodb`. Without Docker: SKIP (acceptable — but confirm the connector change below via Step 4's build at minimum; run with Docker if available to see the real PASS).

- [ ] **Step 3: Add the MongoDB connector case**

In `pkg/statestore/store.go`, add the import and switch case, and update the `ErrUnsupported` doc comment:

```go
import (
	// ...existing imports...
	"github.com/dapr/components-contrib/state/mongodb"
)
```

```go
// ErrUnsupported is returned by New when the component type is not one of the
// four supported backends (state.redis, state.sqlite,
// state.postgresql/postgres, state.mongodb).
var ErrUnsupported = errors.New("unsupported state store type")
```

```go
	switch c.Type {
	case "state.redis":
		inner = redis.NewRedisStateStore(log)
	case "state.sqlite":
		inner = sqlite.NewSQLiteStateStore(log)
	case "state.postgresql", "state.postgres":
		inner = postgresql.NewPostgreSQLStateStore(log)
	case "state.mongodb":
		inner = mongodb.NewMongoDB(log)
	default:
		return nil, fmt.Errorf("%w: %s", ErrUnsupported, c.Type)
	}
```

- [ ] **Step 4: Verify the package compiles**

Run: `go build ./pkg/statestore/ && go build -tags integration ./pkg/statestore/`
Expected: no output (success).

- [ ] **Step 5: Run the MongoDB integration test to verify it passes**

Run: `go test -tags integration ./pkg/statestore/ -run TestMongoStoreContract -v`
Expected with Docker: PASS. Without Docker: SKIP (no FAIL).

- [ ] **Step 6: Run the full statestore + server unit suites for regressions**

Run: `go test ./pkg/statestore/ ./pkg/server/`
Expected: PASS (unit tests; integration tests excluded without the tag).

- [ ] **Step 7: Commit**

```bash
git add pkg/statestore/store.go pkg/statestore/store_integration_test.go
git commit -m "feat(statestore): add MongoDB state store connector + integration test"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (connector + allowlist) → Task 6 (`store.go`) + Task 2 (`api.go`). ✓
- Spec §2 (ConnInfo + Translate) → Task 3 + Task 4. ✓
- Spec §3 (frontend type/label + synthetic-required) → Task 1. ✓
- Spec §4 (testcontainers integration, shared contract, 4 backends, skip-if-no-Docker, replace miniredis) → Task 5 (harness + sqlite/redis/postgres) + Task 6 (mongo). ✓
- Spec §5 (unit tests: conninfo/translate mongo cases, frontend dialog coverage) → Tasks 3, 4, 1. ✓
- Spec §6 (no new error paths; non-goals) → respected; no BulkGet/SRV/secret-store changes introduced. ✓

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" placeholders — all steps carry concrete code or exact commands. Two explicit "match the sibling test helper names" notes (Tasks 1, 2) are deliberate: the exact mock/helper identifiers must be read from the existing test files rather than guessed. ✓

**Type consistency:** `runStoreContract(t, store)` defined in Task 5 and called identically in Task 6. `metaKey`/`histKey`/`keyLike` constants defined once in Task 5, reused by the shared helper. `statestore.New` / `Component` / `Store` signatures match the existing package. `mongodb.NewMongoDB(log)` matches the components-contrib v1.18.0 constructor. Metadata keys (`host`, `databaseName`, `redisHost`, `connectionString`) match each backend's expected fields. ✓