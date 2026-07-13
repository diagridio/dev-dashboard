# MongoDB state-store support + integration tests for all supported stores

**Date:** 2026-07-13
**Status:** Approved

## Goal

Extend the set of state stores the dashboard can connect to for inspecting Dapr
workflow state to include **MongoDB**, and add integration tests that hold every
supported backend to the same observable contract.

After this change the supported backends are:

| Type | Label | Notes |
|---|---|---|
| `state.redis` | Redis | |
| `state.sqlite` | SQLite | |
| `state.postgresql` | PostgreSQL | also accepts the `state.postgres` alias |
| `state.mongodb` | MongoDB | **new** |

## Background

Supported store types are enforced in several places that must stay in sync:

- Backend connector dispatch — [`pkg/statestore/store.go`](../../../pkg/statestore/store.go) `New()`
- Backend display helper — [`pkg/statestore/conninfo.go`](../../../pkg/statestore/conninfo.go) `ConnInfo()`
- Backend compose-network translation — [`pkg/statestore/translate.go`](../../../pkg/statestore/translate.go) `Translate()`
- API allowlist — [`pkg/server/api.go`](../../../pkg/server/api.go) `supportedStoreTypes` / `validateStoreBody()`
- Frontend supported list — [`web/src/lib/storeTypes.ts`](../../../web/src/lib/storeTypes.ts) `SUPPORTED_STORE_TYPES`

MongoDB in `components-contrib` v1.18.0 (`state/mongodb`) exposes `NewMongoDB(logger)`,
implements `state.KeysLiker`, and provides `Close()` — so the existing
`Store` surface (`Keys/Get/BulkGet/Delete/Set/Close`) works against it unchanged.

MongoDB's connection metadata differs from the other backends: it uses
`host` (host:port) **or** `server`, plus `username`/`password`/`databaseName`/
`collectionName`, or a `mongodb://` / `mongodb+srv://` URI — not the single
`connectionString` the others use.

The component metadata bundle
([`pkg/metadata/component-metadata-bundle.json`](../../../pkg/metadata/component-metadata-bundle.json))
**already contains** a stable `mongodb` state component (v1, 11 fields), so the
data-driven manual-connection dialog will render Mongo fields automatically once
the type is added to the frontend allowlist. That bundle marks **no** Mongo field
as required, which the design accounts for below.

## Test infrastructure decision

Postgres and MongoDB have no in-process (miniredis-style) fake, so their
integration tests need a real server. The repo currently has **no**
`testcontainers-go` / Docker-based test infrastructure — existing tests use
in-process fakes (Redis via `miniredis`, SQLite via a temp file with the pure-Go
`modernc.org/sqlite` driver).

**Decision:** adopt `testcontainers-go` with a skip-if-no-Docker guard, and use
it uniformly for the container-backed stores (Redis, Postgres, Mongo). SQLite
continues to use a temp file (no container). The existing miniredis-based Redis
test is **replaced** by a real Redis container for consistency across all four
backends.

## Design

### 1. Backend — MongoDB connector

- `pkg/statestore/store.go` `New()`: add
  `case "state.mongodb": inner = mongodb.NewMongoDB(log)` and the
  `mongodb "github.com/dapr/components-contrib/state/mongodb"` import. Update the
  `ErrUnsupported` doc comment (three → four backends).
- `pkg/server/api.go`: add `"state.mongodb": true` to the `supportedStoreTypes`
  allowlist.

No changes to the `Store` interface or the `ccStore` methods — Mongo satisfies
`KeysLiker` and `io.Closer` like the other backends.

### 2. Backend — display & networking helpers

- `pkg/statestore/conninfo.go`: add a `state.mongodb` case returning a
  **credentials-free** summary. Handle both the field form (`host` +
  `databaseName`) and the `mongodb://[user:pass@]host/db` URI form. As with the
  Postgres case, user/password must never appear in the output. Show
  `host[/databaseName]`.
- `pkg/statestore/translate.go`: add a `state.mongodb` case for compose-network
  host translation, rewriting the `host` field (host:port) the same way Redis's
  `redisHost` is handled. `mongodb+srv://` addresses have no host:port to rewrite
  and pass through untouched.

### 3. Frontend — full UI support

- `web/src/lib/storeTypes.ts`: add `'state.mongodb'` to `SUPPORTED_STORE_TYPES`
  and `'MongoDB'` to the `LABELS` map.
- `web/src/hooks/useComponentCatalog.ts`: add a `SYNTHETIC_REQUIRED` entry for
  `state.mongodb` marking `host` and `databaseName` as required. The bundle marks
  nothing required, so without this the manual-connection form would let users
  save an empty, unusable config.
- `web/src/components/StateStoreConnectionDialog.tsx`: **no changes** — it is
  data-driven from the catalog + synthetic-required map.

### 4. Integration tests (`//go:build integration`)

New direct dependencies in `go.mod`:
`github.com/testcontainers/testcontainers-go` plus its `modules/postgres`,
`modules/mongodb`, and `modules/redis` helpers.

Structure in `pkg/statestore/store_integration_test.go` (Approach C — hybrid):

- A shared `runStoreContract(t, store)` helper asserting the observable contract:
  - seed two keys via `store.Set` using the real Dapr key shape
    (`k||a||1||metadata`, `k||a||1||history-000000`);
  - `Keys` with a LIKE pattern (`k||a||1||%`) returns both seeded keys;
  - `Get` round-trips a value;
  - `Delete` removes exactly one key, leaving the other.
- Four thin per-backend test funcs, each provisioning then calling the helper:
  - **SQLite** — temp-file DB, no container, never skips.
  - **Redis** — testcontainers `redis` module (replaces the miniredis test and
    its `INFO replication` pre-hook, which is unnecessary against real Redis).
  - **Postgres** — testcontainers `postgres` module.
  - **Mongo** — testcontainers `mongodb` module.
- The three container tests call `testcontainers.SkipIfProviderIsNotHealthy(t)`
  up front so they `t.Skip()` cleanly when Docker is unavailable rather than
  failing.

### 5. Unit tests (no build tag)

- `pkg/statestore/conninfo_test.go`: add Mongo cases — field form (`host` +
  `databaseName`), `mongodb://` URI, and explicit credential-stripping
  assertions.
- `pkg/statestore/translate_test.go`: add Mongo cases — host:port rewrite on a
  translation hit, and a foreign-host passthrough (no rewrite).
- Frontend: extend `web/src/lib/*` coverage for the new type/label and
  `web/src/components/StateStoreConnectionDialog.test.tsx` to assert MongoDB
  appears in the type dropdown and its synthetic-required fields gate the Save
  button. Verify `web/src/test/styleguide.test.ts` does not need the new label
  allowlisted.

### 6. Error handling & non-goals

- No new error paths: unsupported types still return `ErrUnsupported` (backend)
  and `ErrUnsupportedStoreType` (API); MongoDB simply joins the supported set.
- **Non-goals:**
  - No `BulkGet` optimization (still a sequential loop).
  - No `mongodb+srv`-specific compose translation — SRV addresses have no
    host:port to rewrite and pass through untouched.
  - No secret-store wiring changes — the existing `SecretRefs` /
    `auth.secretStore` flow covers Mongo unchanged.

## Files touched (summary)

**Backend**
- `pkg/statestore/store.go` — Mongo connector case + import + doc comment
- `pkg/statestore/conninfo.go` — Mongo display summary (no creds)
- `pkg/statestore/translate.go` — Mongo host translation
- `pkg/server/api.go` — allowlist entry

**Frontend**
- `web/src/lib/storeTypes.ts` — type + label
- `web/src/hooks/useComponentCatalog.ts` — synthetic-required Mongo fields

**Tests**
- `pkg/statestore/store_integration_test.go` — shared contract + 4 backends
- `pkg/statestore/conninfo_test.go`, `pkg/statestore/translate_test.go` — Mongo unit cases
- `web/src/components/StateStoreConnectionDialog.test.tsx`, `web/src/lib/*` — UI coverage
- `go.mod` / `go.sum` — testcontainers-go + modules