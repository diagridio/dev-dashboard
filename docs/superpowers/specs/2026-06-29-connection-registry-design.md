# Connection registry + lazy multi-connection backend (Spec 2b)

**Date:** 2026-06-29
**Status:** Approved design
**Scope:** Spec 2b of 3. Builds on 2a (secret resolution). 2c (frontend connection
manager + store selector) follows and depends on this backend.

## Problem

The dashboard connects to exactly one **active** state store (elected from the
running apps) and closes the previous connection whenever the active store
changes. So when a user switches a workflow app from one state store to another
(e.g. redis → postgres, or a renamed app under a different store), the old
store's workflow data becomes unreachable — the dashboard no longer connects to
it, and once the app stops it is no longer even detected.

`server.WorkflowBackend.ServiceFor(name)` and the `?store=` API param already
exist, and `GET /api/statestores` already returns a list — but only the active
store is ever connected or listed.

## Goal

Let the dashboard remember state stores across app stops and dashboard restarts,
and connect to any remembered store on demand, so a user can view workflow data
in a store whose app is no longer running. Persist the remembered set to a
user-profile file the user can manage (add/edit/remove). Connect lazily.

## Decisions (from brainstorming)

- **Persisted registry file** in the user profile is the source of truth for what
  the backend can connect to. The browser persists only the *current selection*
  (deferred to 2c).
- **Hybrid entries:** auto-discovered stores are persisted as **references** to
  their component-YAML path (no secrets in the file; re-read + 2a-resolved on
  connect). Manually-added connections store their inline connection details
  (possibly secrets) in the file (`0600`).
- **Auto-persist:** every discovered store is automatically upserted as an `auto`
  entry (deduped), so the switch-stores case is hands-free.
- **Lazy connect:** a store is opened only when selected (or, for the active
  store, pre-warmed); connections are cached for the session.
- **Cross-platform paths:** all paths go through Go `path/filepath`; the registry
  file is read/written via the YAML marshaler (round-trips Windows backslash
  paths); auto entries dedup by normalized absolute path.

## Architecture

Three focused units behind the existing `server.StoreRegistry` /
`server.WorkflowBackend` interfaces (extended), so HTTP handlers change minimally.

1. **`registry`** — owns the user-profile file: load/save, auto-persist discovered
   stores as refs, and CRUD for manual entries.
2. **`connpool`** — a lazy connection cache keyed by store identity
   (`name|type|ConnInfo`): opens a store on first use, caches it, closes all on
   shutdown. Generalizes the reconciler's current single-connection logic.
3. The **reconciler** integrates them: each reconcile it feeds discovered stores
   into the `registry` (auto-persist) and pre-warms the elected **active** store
   through the `connpool`. It still elects the active store (for the default
   selection and the `active` flag) and keeps its fingerprint/single-flight
   machinery. It no longer owns a single connection or closers.

### 1. The registry

**Location/format:** `filepath.Join(homeDir, ".dapr", "dev-dashboard", "connections.yaml")`
(`homeDir` is `os.UserHomeDir()`, already injected into the backend). YAML,
permissions `0600`. The `~/.dapr/dev-dashboard/connections.yaml` shorthand always
means this `filepath.Join`-built path — never a hardcoded `/` or `~`.

**Entry shape:**
```yaml
connections:
  - name: workflow-store
    type: state.redis
    source: auto                 # auto | manual
    path: /…/Resources/statestore.yaml   # auto: re-read + 2a-resolve on connect
  - name: my-pg
    type: state.postgresql
    source: manual
    metadata:                    # manual: inline connection details (may contain secrets)
      connectionString: "host=… dbname=… user=… password=…"
```

**Identity / dedup:**
- `auto` entries are keyed by **normalized absolute path** (`filepath.Clean` of the
  abs path; compared case-insensitively on Windows). Path-keying (not name-keying)
  keeps two different projects that both name their store `statestore` as distinct
  entries — required for viewing an old project's workflows after switching.
- `manual` entries are keyed by their user-given `name`.

**Auto-persist:** on each reconcile, every detected store is upserted as an `auto`
entry keyed by its normalized path (re-discovery does not duplicate; the entry's
`name`/`type` are refreshed if the YAML changed). Auto-persist never overwrites a
`manual` entry.

**CRUD:** manual entries can be added/edited/removed; any entry (manual or auto)
can be deleted. A deleted `auto` entry reappears if its app is rediscovered —
acceptable. Saves are serialized under a mutex.

**Cross-platform:** read/write only through the `sigs.k8s.io/yaml` marshaler so a
Windows path (`C:\Users\…`) is escaped/round-tripped correctly. Never hand-format
the file. The registry file is per-machine, so paths never cross OSes.

### 2. The lazy connection pool

`connpool` caches connections keyed by identity (`name|type|ConnInfo`):

- `openOrGet(ctx, component) (storeEntry, error)`: return the cached entry for that
  identity, or open via `statestore.New` (with 2a-resolved metadata), build the
  `storeEntry` (`workflow.Service` + `WorkflowRemover` + `TargetResolver`), cache,
  and return. **Per-identity single-flight** so concurrent selects open once; the
  open runs outside the map lock so a slow connect never blocks other stores.
- `Close()` closes every cached connection (shutdown).

**Retention is the feature:** unlike the current reconciler, the pool does **not**
close the old active store when the active changes — it stays cached and viewable.
Retention is unbounded for the session (fine for a dev tool's handful of stores;
idle/LRU eviction is a noted future option, out of scope for 2b).

### 3. Backend integration (`ServiceFor` + reconciler)

`ServiceFor(name)`:
- `name == ""` → the active store (elected by the reconciler, pre-warmed in the
  pool). Default view, unchanged.
- `name` matches a registry entry → build its `statestore.Component` (auto: read
  the YAML at `path` + `DetectSecretStores` + `ResolveSecrets`; manual: inline
  `metadata`) → `connpool.openOrGet` → return its entry. A connect failure returns
  an error the API surfaces (unreachable).
- unknown `name` → `ok=false` → API "unknown store" (today's behavior).

The reconciler holds the `registry` and `connpool`; its `Stores()` and
`ServiceFor` delegate to them. Each reconcile: auto-persist discovered stores →
registry; pre-warm active store → pool. `Close()` closes the pool.

## API surface

- `GET /api/statestores` → all registry entries (auto ∪ manual, deduped) as
  `StoreInfo`, with a new `source` field (`auto`|`manual`); `active` marks the
  elected active store; `connection` stays the secrets-free `ConnInfo`. The list
  opens **no** DB connections — for an `auto` entry it reads+resolves its YAML to
  compute `connection` (a file read, no connect); a missing YAML yields an empty
  `connection` (unreachable), not an error.
- `POST /api/statestores` → add a manual connection `{name, type, metadata}`;
  validates `type` ∈ {`state.redis`, `state.sqlite`, `state.postgresql`} and
  required fields; writes the registry.
- `PUT /api/statestores/{name}` → edit a manual connection.
- `DELETE /api/statestores/{name}` → remove any entry; close+evict its pooled
  connection if open.
- `GET /api/workflows?store=<name>` (and stats / detail / remove, already
  `store`-aware) route through `ServiceFor(name)` → the lazy pool.

`server.StoreRegistry` is extended from `Stores() []StoreInfo` to also carry the
add/update/delete mutators; `StoreInfo` gains `Source string`.

## Error handling

- Malformed registry file → log and start with an empty registry; never crash.
- Missing YAML for an `auto` entry → unreachable in the list; a select attempt
  errors gracefully (surfaced by the API).
- Connect failure on select → returned as an error the UI shows.
- Unsupported `type` on POST/PUT → 400; required-field validation.
- Concurrent registry writes → serialized under a mutex.

## Security

- Registry file `0600`. `auto` entries hold only a path; secrets stay in the
  component YAML and are resolved on connect (2a). Only hand-entered `manual`
  entries place inline connection details (possibly secrets) in the file.
- The list endpoint returns only secrets-free `ConnInfo`, never raw metadata.
- POST/PUT accept connection details (possibly secrets) in the request body; this
  is acceptable because the server binds `127.0.0.1` only.

## Testing

- `registry` units: load/save round-trip **including a backslash Windows-style
  path** (asserts marshaler escaping); auto-persist upsert dedups by normalized
  path; manual add/edit/delete; deleting an auto entry; malformed file → empty.
- `connpool` units (fake opener counting opens): `openOrGet` caches (opens once);
  per-identity single-flight; `Close` closes all; switching the active store
  **retains** the old connection (close count stays 0).
- backend `ServiceFor`: active (`""`) vs named-auto vs named-manual vs unknown.
- integration (SQLite, no external services): a running app provides store A
  (`auto`); a pre-seeded registry file has a manual SQLite store B seeded with a
  workflow instance. `GET /api/statestores` lists both with correct `source` and
  `active`; `GET /api/workflows?store=B` returns B's instance through the lazy
  pool while A remains the active default; `GET /api/workflows` (no store) returns
  A's view.

## Out of scope (→ Spec 2c)

- The frontend connection-manager UI and the store selector.
- Per-store "not running" / "unresolved credentials" status display (the backend
  may expose `source` + `connection`; richer status is 2c).
- Browser persistence of the current selection.

Also deferred (not 2c): idle/LRU eviction of the connection pool.
