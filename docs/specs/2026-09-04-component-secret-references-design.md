# Component Secret References — Design

**Date:** 2026-09-04
**Status:** Design — awaiting review
**Issue:** [#94 — Local secret store not showing up or working with components](https://github.com/diagridio/dev-dashboard/issues/94)
**Area:** new `pkg/secrets`, `pkg/statestore`, `pkg/resources`, `pkg/server`, `cmd`,
`web/src/pages/ResourceDetail.tsx`, `web/src/components/StateStoreConnectionsPanel.tsx`

## Problem

Dapr components keep credentials out of YAML by referencing a secret store:

```yaml
spec:
  metadata:
  - name: redisPassword
    secretKeyRef:
      name: redis:password
auth:
  secretStore: localsecretstore
```

The dashboard handles this badly. Secret resolution exists, but it lives in
`pkg/statestore/secrets.go`, is reachable only from the state-store connection
path, and is wrong in several ways. Nothing about secrets is visible in the UI
at all: a component whose password comes from a secret store looks identical to
one that resolves fine, right up until a connection fails with an opaque error.

Each of the following was reproduced against the code at `cb97494`, not
inferred.

**Nested keys never resolve.** `DetectSecretStores` parses `nestedSeparator`
into `SecretStore.NestedSeparator` and then never reads it. `resolveFromFile`
instead does its own two-level lookup. Given the canonical Dapr layout —

```json
{ "redis": { "password": "nested" } }
```

— a `secretKeyRef.name` of `redis:password` returns `unresolved`. This is the
form the Dapr docs use, so it is the common case, not an edge case.

**`local.env` ignores `prefix`.** `resolveOne` calls `os.Getenv(key)` directly.
A store configured with `prefix: MYAPP_` and a ref named `REDIS_PASSWORD`
resolves nothing, because the actual variable is `MYAPP_REDIS_PASSWORD`.

**`multiValued` is unimplemented**, so the alternate file layout it enables
silently misbehaves.

**Failures are invisible.** `ResolveSecrets` returns an `unresolved` list, and
both call sites in `cmd/reconciler.go` (lines 145-150 and 275-279) drop it into
a `slog.Warn`. Nothing reaches the API, so the user sees a state-store dial
failure with no indication that a secret was the cause.

**`--statestore` disables secret detection entirely.** `derivePaths`
(`cmd/derive.go:52-53`) collapses `scanPaths` to exactly the one YAML named by
the flag. `DetectSecretStores` walks `scanPaths`. With that flag set, no secret
store is ever found and every `secretKeyRef` in the target store fails.

**Secret stores are scoped to the state-store path set.** `scanPaths` answers
"where are the state stores" — `~/.dapr/components` plus running apps'
`ResourcePaths`. `resPaths`, which the Components page walks, additionally
covers all of `~/.dapr` recursively, config-file directories, and aspire's
`extraResPaths`. A secret store in any of those lists on the Components page
but is invisible to the resolver: exactly the reported "shows up but doesn't
work".

**`envRef` is unsupported.** Dapr resolves `spec.metadata[].envRef` straight
from the environment (`dapr/pkg/runtime/processor/secret.ProcessResource`). The
dashboard ignores the field, so such components display as having no value at
all.

## Goals

- Resolve `secretKeyRef` and `envRef` with the same semantics as the Dapr
  runtime, for `secretstores.local.file` and `secretstores.local.env`.
- Show every secret reference on a component's detail pane with its resolution
  status, and enough detail to fix it when it fails.
- Show a local secret store's own configuration and its available key names, so
  the correct `secretKeyRef.name` is discoverable rather than guessed.
- Name the secret as the cause when a state-store connection fails because of
  an unresolved reference.
- Detect secret stores anywhere the Components page finds components.
- One resolution implementation, shared by the Components page and the
  state-store connection path.

## Non-goals

- **The component builder's missing `auth.secretStore`.** `assembleComponentSpec`
  (`web/src/pages/component-builder/reducer.ts:187-189`) emits `secretKeyRef`
  entries but never an `auth` block, and `ComponentSpec` has no `auth` field —
  so the YAML it generates cannot resolve under standalone Dapr. This is a real
  and independent defect; it gets its own issue rather than riding along here.
- **Non-local secret stores** (vault, Azure Key Vault, AWS, GCP, Kubernetes).
  They are detected and listed as ordinary components but never resolved, and
  their refs report `store-unsupported`.
- **Reading daprd's real environment or working directory.** Rejected: gopsutil
  v3 does not implement `Environ`/`Cwd` on darwin, and reading other processes'
  full environments is a materially larger security surface than this feature
  justifies. See "Resolution context" below.
- **Kubernetes mode** and its default `kubernetes` secret store.
- **Creating, editing, or deleting secrets.** The dashboard is a read-only
  observer of secret material.

## Approach

Do not reimplement Dapr's semantics — **instantiate Dapr's actual secret
stores**. `github.com/dapr/components-contrib v1.18.0` is already a direct
dependency, and importing `secretstores/local/file` and `secretstores/local/env`
pulls in **no new modules** (verified: `go mod tidy` leaves `go.mod` unchanged).

Their behaviour was confirmed directly:

| `GetSecret` name | result |
| --- | --- |
| `redisPassword` | `{redisPassword: flat}` |
| `redis:password` | `{redis:password: nested}` |
| `redis` | error: `secret redis not found` |

That last row is the point. With `multiValued: false` (the default) the store
**flattens** nested JSON into `parent<sep>child` keys, so `redis` is not a key
at all. Reimplementing this by hand is how the current bug happened.

Two alternatives were considered and rejected. Extending `pkg/statestore` and
importing it from `pkg/resources` would couple the "walk YAML files" package to
the one carrying the redis/postgres/mongo/sqlite drivers, making a Components
page request transitively depend on database clients; it also cements a wrong
home, since secret stores are not state stores. Resolving in the `pkg/server`
handler layer would put domain logic in the router, against the architectural
rule, and would leave `cmd/reconciler` on a separate copy — the exact
duplication that produced this bug.

## Architecture

### `pkg/secrets` — the resolver

A new isolated domain package. It imports contrib's two local stores and
nothing from `cmd/`.

```go
package secrets

// Store is a detected local secret-store component.
type Store struct {
    Name       string            // metadata.name
    Type       string            // secretstores.local.file | secretstores.local.env
    Path       string            // abs path of the YAML that declared it
    Properties map[string]string // spec.metadata, verbatim
    File       string            // local.file: the absolute secretsFile actually opened
    InitErr    string            // non-empty when Init failed
}

type Ref struct {
    Kind string // "secretKeyRef" | "envRef"
    Name string // secret name, or env var name for envRef
    Key  string // "" means: fall back to Name
}

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

type Result struct {
    Status Status
    Value  string // populated only on the reveal path; never serialized in list responses
    Detail string // human-facing: the env var name or absolute file path actually tried
}

type Service interface {
    Stores(ctx context.Context) []Store
    Resolve(ctx context.Context, storeName string, ref Ref) Result
    KeyNames(ctx context.Context, storeName string) ([]string, error) // names only, never values
}

func New(paths func() []string) Service
```

`Resolve` mirrors `dapr/pkg/runtime/processor/secret.ProcessResource` exactly:

- An empty `Key` falls back to `Name`.
- An empty `auth.secretStore` has **no default in standalone mode**
  (`meta.AuthSecretStoreOrDefault` defaults to `kubernetes` only under
  `modes.KubernetesMode`), so it reports `store-not-specified` rather than
  guessing.
- A resolved-but-empty value is **not** applied by the runtime
  (`if ok && val != ""`), so it reports `empty-value` — a distinct state from
  `key-not-found`, and one a status-only UI could not otherwise explain.
- `envRef` is resolved from the environment behind Dapr's own
  `isEnvVarAllowed` denylist: empty keys, `APP_API_TOKEN`, any `DAPR_`-prefixed
  name, and any name containing a space are refused (`forbidden`). The
  `DAPR_ENV_KEYS` allowlist is mirrored too — it is injector-set and
  Kubernetes-only, but honouring it costs six lines and keeps us bit-identical
  to the code path being emulated.
- Contrib's `local.env` store applies the same denylist internally, so
  `secretKeyRef` against an env store inherits it for free.

**Store caching.** Contrib's file store reads and caches its JSON at `Init`.
`pkg/secrets` keys initialized stores on `(path, size, mtime, properties)` and
caps an entry's lifetime to the app poll interval, so an edit to `secrets.json`
appears on the next poll and a same-second edit cannot stick behind mtime
granularity.

**Relative `secretsFile`.** Resolved against a documented candidate list — the
declaring YAML's directory first, then the parent of the app resource path that
contained it. `Store.File` records which candidate actually opened; on failure
the candidates tried are reported in `Detail`.

### Resolution context

The dashboard is a different process from daprd, so its environment and working
directory differ. This design resolves against the **dashboard's own** context
and says so plainly rather than pretending otherwise: `local.env` reads the
dashboard's environment, and every failure names the exact variable or absolute
path tried, so a mismatch is visible instead of mysterious. This behaves
identically on all three supported platforms and adds no process introspection.

### Detection and path wiring

`cmd/serve.go:152` already hands `resources.New` the reconciler's full path
provider, `rc.Paths()` (that is `resPaths`). `pkg/secrets` is fed from **the
same provider**:

```go
secretsSvc := secrets.New(rc.Paths)
Resources: resources.New(rc.Paths, deps.ExtraResources, resources.WithSecrets(secretsSvc)),
```

This fixes both Section-2 defects at once: `--statestore` no longer narrows
secret detection (that flag governs state-store election, not secret stores),
and a secret store anywhere the Components page looks is now resolvable. It
also makes drift between the two surfaces structurally impossible, since there
is one path set and one detector.

`statestore.DetectSecretStores` and `statestore.ResolveSecrets` are **deleted**;
`cmd/reconciler.go` calls `pkg/secrets` at both existing call sites.
`statestore.Component` keeps its `SecretRefs`/`SecretStore` fields — `Detect`
still parses its own YAML — but the shared `secretKeyRef` / `envRef` /
`auth.secretStore` parsing moves to `pkg/secrets` so `pkg/resources` and
`pkg/statestore` cannot disagree about what a reference is.

**Container-sourced components degrade honestly.** `resources.Service` merges an
`extras` provider for YAML extracted from Testcontainers and compose containers.
A secret store declared there points at a `secretsFile` inside the container,
and its environment is not the dashboard's. Those stores report
`store-unreadable` with the reason ("declared inside container `x`; its
secretsFile is not on this host") rather than a misleading `key-not-found`.

**Namespaces are deliberately ignored.** Dapr passes `namespace` in the
`GetSecret` request metadata, but neither local store reads it, so matching
stores by `metadata.name` alone is correct.

## API

`pkg/resources.Resource` gains two value-free fields:

```go
type SecretRefStatus struct {
    Field  string `json:"field"`            // spec.metadata[].name, e.g. "redisPassword"
    Kind   string `json:"kind"`             // "secretKeyRef" | "envRef"
    Store  string `json:"store,omitempty"`  // auth.secretStore; "" when unset
    Name   string `json:"name,omitempty"`   // secret name / env var name
    Key    string `json:"key,omitempty"`    // effective key (defaults to Name)
    Status string `json:"status"`
    Detail string `json:"detail,omitempty"` // "tried /abs/path/secrets.json"
}

type SecretStoreInfo struct {
    Name    string   `json:"name"`
    Type    string   `json:"type"`
    File    string   `json:"file,omitempty"`     // resolved absolute secretsFile
    Prefix  string   `json:"prefix,omitempty"`   // local.env
    Keys    []string `json:"keys,omitempty"`     // names only, never values
    KeysCap bool     `json:"keysCapped,omitempty"`
    InitErr string   `json:"initErr,omitempty"`
    UsedBy  []string `json:"usedBy,omitempty"`   // component names referencing this store
}
```

`SecretRefs []SecretRefStatus` is populated on **both** `List` and `Get`.
That is affordable only because of the store cache: `scan` already reads every
YAML on every poll, so parsing refs is free, and resolution collapses to a map
lookup after the first file read. It buys the list an at-a-glance "this
component has an unresolved secret" marker — the signal that would have told
the reporter what was wrong. `SecretStore *SecretStoreInfo` is populated only
for components that are themselves local secret stores, and only on `Get`,
since it requires a bulk read.

### The reveal endpoint

Showing status alone cannot explain a trailing newline, a wrong nested key, or
an empty string. Values are therefore masked with an explicit per-field reveal.
This is a **deliberate, narrow exception** to this codebase's standing
convention that secret material never crosses the API boundary — the convention
visible in `StoreInfo.Connection`, documented as a "secrets-free host/db summary
for display" (`cmd/reconciler.go:357`).

```
POST /api/resources/component/{id}/secret-value
     {"field":"redisPassword"} → {"value":"..."}
```

POST rather than GET, for three specific reasons:

1. `requestGuard` applies its cross-origin `Origin` check **only** to
   POST/PUT/DELETE/PATCH (`pkg/server/middleware.go:53`). A GET would get only
   the loopback-`Host` check.
2. RUM runs with `trackResources: true`, which records request URLs. Bodies and
   response bodies are not recorded.
3. A POST cannot be triggered by `<img>`, prefetch, or a link scanner.

The response sets `Cache-Control: no-store`. Each reveal logs
`slog.Info("secret revealed", component, field)` — never the value.

**Reveal is loopback-only.** When `allowAnyHost` is true (aspire/container
mode, reached through a proxy on an arbitrary host) the endpoint returns `403`
and the UI disables the toggle with an explanation. Container mode is precisely
where shipping credentials over the wire matters most, and this repo has
deliberately never done so. Status remains fully available in that posture.

### Connection diagnostics

`server.StoreInfo` gains `secretIssue string`. `cmd/reconciler.Stores()`
already resolves each entry through `componentForEntry` and currently discards
the unresolved list into a `slog.Warn`; instead it becomes a sentence:

```
redisPassword unresolved: store "localsecretstore" has no key "redis:password"
```

`StateStoreConnectionsPanel` renders it inline under the entry, and the State
page appends it to its error banner. This replaces today's opaque dial failure.

## UI

Built from the existing `.panel` / `.kv` / `.pill` vocabulary in
`web/STYLEGUIDE.md`; no new primitives, no hardcoded colors.

**Component detail — "Secret references" panel.** `ResourceDetail.tsx` today is
a header plus `<pre class="code">`. When `secretRefs.length > 0`, a `.panel`
renders above the YAML: a `.ph` header naming the `auth.secretStore` and linking
to that store's own component page (a secret store is a component here, so the
link already exists), then one `.kv` row per reference. The key is the field
(`.kk.mono`, e.g. `redisPassword`); the value is a status pill, the reference
itself (`localsecretstore → redis:password`), and — when resolved —
`••••••••` with a reveal toggle. Unresolved rows carry `Detail` inline in
`var(--muted)`: *"tried /Users/…/components/secrets.json"*.

Status pills get their own namespace per the styleguide's
build-a-class-from-data antipattern: `.pill.secref-ok` / `.secref-warn` /
`.secref-err`, in a small `SecretStatusPill` component. `StatusPill` is
`WorkflowStatus`-typed and is not widened.

**Secret store detail — a type-aware panel.** When the selected component's type
is `secretstores.local.*`:

- **`local.file`** — the absolute `secretsFile` actually opened (or the
  candidates tried, on failure), `nestedSeparator`, `multiValued`, and **the
  list of key names**. This is the highest-value part of the feature: it shows
  `redis:password`, not `redis`, making the flattening rule that broke the
  reporter's component self-evident rather than tribal knowledge.
- **`local.env`** — the `prefix`, plus a note that names come from *the
  dashboard's* environment and that `DAPR_*` / `APP_API_TOKEN` are denied. Key
  names are listed **only when a prefix is set**; with no prefix, a bulk read
  would dump the user's entire environment into the UI, so it shows a hint
  instead.
- **Both** — a "referenced by" list of components using this store. `Get`
  already calls `scan()` over everything, so the cross-reference is free.

**Reveal behavior.** Per-field toggle with `aria-pressed`, value fetched on
demand, cleared on unmount and navigation, and **auto-re-masked after 30
seconds** — this dashboard gets screen-shared in demos, which is the concrete
risk that made masked-with-reveal the right default. Disabled with an
explanatory `title` in container posture.

**List rail.** One unobtrusive `⚠` marker with an accessible label on
components with unresolved references, so the problem is noticeable from the
Components page without opening each entry.

**Telemetry.** The reveal `trackAction` sends the component *type* only — never
the component name, field name, or value.

## Testing

Per the repo's build-tag gates (`make test` runs `unit` + web; `integration`
runs in CI).

- **`pkg/secrets` (`unit`)** — table-driven over real fixture files: flat key,
  nested via default and custom `nestedSeparator`, `multiValued` true and false,
  missing file, malformed JSON, key-not-found, empty-value, env with and without
  `prefix`, the `DAPR_*` / `APP_API_TOKEN` / space denylist, `envRef`,
  `store-not-specified`, `store-not-found`, `store-unsupported`. Because
  resolution delegates to contrib, these **double as a pin on contrib's
  behaviour**: a future bump that changes flattening fails loudly here instead
  of silently breaking resolution again.
- **`pkg/resources` (`unit`)** — DTO population, plus a guard test that marshals
  a resource with resolved refs and asserts **no secret value appears anywhere
  in the JSON**. This is the regression guard for the no-secrets-over-the-API
  convention.
- **`cmd` (`unit`)** — the two path defects directly: secret stores are still
  detected when `--statestore` is set, and a secret store under `~/.dapr` but
  outside `~/.dapr/components` resolves. Extends
  `cmd/secret_resolution_integration_test.go` rather than duplicating it.
- **`pkg/server` (`unit`)** — reveal returns 200 on loopback, **403 under
  `allowAnyHost`**, 404 for an unknown field, sets `Cache-Control: no-store`,
  and is not reachable by GET.
- **`integration`** — the assembled server over a temp components directory with
  a real `secrets.json`: the list carries statuses, reveal returns the value.
- **Web (vitest)** — panel rendering per status, reveal toggle → POST →
  auto-re-mask (fake timers), disabled state in container posture, file-vs-env
  store panels including the no-prefix hint, and the list-rail marker. The
  existing `src/test/styleguide.test.ts` hex-literal guard must still pass.
- **Typecheck** — `make build` after any `.ts(x)` change. Vitest does not
  typecheck, which has produced type errors that reached review in this repo
  before.
- **No e2e.** Resolution is host-side file and environment reading; a real
  `daprd` would add nothing.

## Risks

- **Contrib coupling.** A `components-contrib` bump could change secret-store
  semantics. Mitigated by the pin tests, which assert the exact behaviour rather
  than mocking it.
- **Cache staleness.** Keying on `(path, size, mtime)` and capping entry
  lifetime to the poll interval keeps a same-second edit from sticking.
- **Large secrets files.** The key-name list caps at 200 entries and says
  *"…and N more"* — an explicit cap, never a silent truncation.

## Acceptance criteria

Mapped to issue #94:

1. *Local secret store components are detected and shown, same as other
   component types* — they list on the Components page (already true) and gain a
   type-aware detail panel showing configuration, resolved file path, and
   available key names.
2. *`secretKeyRef` metadata fields resolve correctly against local file/env
   secret stores* — resolution delegates to contrib's own stores, so
   `nestedSeparator`, `multiValued`, and `prefix` behave exactly as in Dapr;
   `envRef` is supported; and detection covers every path the Components page
   scans, including under `--statestore`.
3. *Steps to reproduce should include OS, dashboard version, and how the local
   secret store component is configured* — no work required.
   `.github/ISSUE_TEMPLATE/bug_report.yaml` already collects OS type, dashboard
   version, Dapr version, and steps to reproduce; issue #94 was filed without
   them. This criterion is about how the report was written, not about the
   product, and needs no code or template change.
