# Resolve secretKeyRef for state-store connections (Spec 2a)

**Date:** 2026-06-29
**Status:** Approved design
**Scope:** Spec 2a of 3. This is the first, independent slice of the larger
"state-store connection manager" effort. 2b (connection registry + lazy
multi-connection backend) and 2c (frontend connection manager + store selector)
follow and depend on this.

## Problem

The dashboard connects to a Dapr state store by reading the component YAML's
inline `spec.metadata[].value` fields and passing them to
`statestore.New`. Today (`pkg/statestore/detect.go`), `rawComponent` parses
**only** `spec.metadata[].name` + `spec.metadata[].value`; there is **no secret
handling anywhere** in `pkg/` or `cmd/`.

So a component that supplies a credential via Dapr's `secretKeyRef` instead of an
inline value carries no value the dashboard can see. The metadata entry is
silently dropped, the store is initialised without the credential, and the
connection fails (e.g. redis `NOAUTH`). This is a **pre-existing gap that
affects the currently-active store** — not specific to the later multi-store
work — which is why it is sequenced first: fixing it immediately improves the
connection the dashboard already makes, and is a prerequisite for connecting
remembered stores in 2b.

## Goal

When connecting a state store, resolve metadata supplied via `secretKeyRef`
using Dapr's two **local** secret-store types (`secretstores.local.file`,
`secretstores.local.env`), so such components connect. Components using only
inline values are unaffected. Anything unresolvable degrades gracefully (no
crash), matching today's skip-with-warning behavior.

## Background: the Dapr component shapes involved

State-store component using a secret reference:

```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: workflow-store
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: "localhost:16379"
  - name: redisPassword
    secretKeyRef:
      name: redis-secret      # secret name
      key: redis-password     # key within the secret
auth:
  secretStore: local-secret-store
```

`auth` is a **top-level** field of the component (sibling of `spec`/`metadata`).

Local secret-store components:

```yaml
# secretstores.local.file
spec:
  type: secretstores.local.file
  version: v1
  metadata:
  - name: secretsFile
    value: ./secrets.json
  - name: nestedSeparator    # optional, default ":"
    value: ":"
```
```yaml
# secretstores.local.env (no required metadata)
spec:
  type: secretstores.local.env
  version: v1
```

`local.file` secrets JSON is either nested (`{"redis-secret":{"redis-password":"…"}}`)
or a flat string (`{"redis-secret":"…"}`).

## Design

### 1. Extend component parsing (`pkg/statestore`)

Extend `rawComponent` to also capture, per metadata entry, `secretKeyRef: { name, key }`,
and the component-level `auth.secretStore`. The parsed `Component` gains:

- `SecretRefs map[string]SecretRef` — metadata-name → `{ SecretName string; Key string }`, populated only for entries that used `secretKeyRef` (entries with an inline `value` stay in `Metadata` as today).
- `SecretStore string` — the value of `auth.secretStore`.

`SecretRef` is a new small struct in the package. Inline-only components produce
an empty `SecretRefs` and behave exactly as before.

### 2. Detect local secret-store components (`pkg/statestore`)

Add detection of secret-store components, reusing the existing YAML walker so
there is no duplicate directory traversal. It returns the local secret stores
found under the given paths:

- `DetectSecretStores(paths []string) ([]SecretStore, error)` where `SecretStore`
  carries `Name`, `Type` (`secretstores.local.file` / `secretstores.local.env`),
  and the parsed config it needs (for `local.file`: the resolved `secretsFile`
  path and `nestedSeparator`).
- Non-local secret-store types are ignored (not returned).

### 3. Resolver (focused unit)

`ResolveSecrets(c Component, stores []SecretStore) (map[string]string, []string)`:

- Start from a copy of `c.Metadata` (the inline values).
- For each `(metaName, ref)` in `c.SecretRefs`: find the secret store named
  `c.SecretStore` among `stores`.
  - `secretstores.local.file`: read the store's `secretsFile` JSON. Look up
    `ref.SecretName`: if its value is a string, use that string; if it is an
    object, use `[ref.Key]`. (`nestedSeparator`-flattened keys are handled by
    the object lookup.)
  - `secretstores.local.env`: use `os.Getenv(ref.Key)` (falling back to
    `ref.Name` when `Key` is empty).
  - Unknown/unsupported secret-store type, store not found, file unreadable, or
    secret/key missing → leave `metaName` unset and append it to the returned
    `unresolvedKeys`.
- Return the resolved metadata map and the list of unresolved metadata keys.

The resolver is pure except for reading the secrets file / env — input is the
component + detected secret stores, output is the resolved map + unresolved
list. It is testable with temp YAML/JSON files and `os.Setenv`, no real DB.

### 4. Wiring into the connection path (`cmd/reconciler.go`)

In `reconcile`, after `statestore.Detect(scanPaths)`:

1. `secretStores, _ := statestore.DetectSecretStores(scanPaths)` (same scan
   paths already derived for state-store detection).
2. For each detected state-store component, replace its `Metadata` with
   `ResolveSecrets(component, secretStores)`'s resolved map before the
   active-store election / `statestore.New`.

So whichever component becomes active is opened with resolved metadata. This is
the only behavioral change to the connection path; election, the lazy/diff
connection logic, and `statestore.New` are otherwise untouched. A component
whose secrets cannot be resolved attempts to connect as today and fails
gracefully (the existing "state store init failed, skipping" warning).

## Error handling

- Unsupported secret-store types, missing stores, unreadable files, and missing
  secrets never crash. They leave the affected metadata key unset, which results
  in the existing graceful skip-with-warning if the connection then fails.
- `secretstores.kubernetes` and any remote secret store are out of scope and
  treated as unsupported (left unresolved). This is a local self-hosted dev tool.

## Testing (TDD)

- `ResolveSecrets` unit tests (temp dirs):
  - `local.file` nested form (`{"redis-secret":{"redis-password":"…"}}`) → resolved.
  - `local.file` string form (`{"redis-secret":"…"}`) → resolved.
  - `local.env` via `os.Setenv` → resolved.
  - unsupported secret-store type → key in `unresolvedKeys`, not in metadata.
  - referenced secret store not detected / secret missing → `unresolvedKeys`.
  - inline-only component → metadata unchanged, `unresolvedKeys` empty.
- Parsing tests: `secretKeyRef` (name+key) and `auth.secretStore` captured into
  `SecretRefs`/`SecretStore`; inline values still parsed into `Metadata`.
- `DetectSecretStores` test: finds `local.file`/`local.env`, ignores others.
- Integration test (no external services): a reconciler/assemble path where a
  **SQLite** state store's `connectionString` is supplied via a `secretKeyRef`
  resolved from a `local.file` secret store → resolves → connects → serves a
  seeded workflow through the existing wired path.

## Out of scope (later specs)

- The user-profile connection-registry file (auto-refs + manual entries) — Spec 2b.
- Lazy multi-store connection cache and `/api/statestores` returning all stores — Spec 2b.
- The frontend connection-manager UI and store selector — Spec 2c.
- A richer per-store "unresolved credentials" status in the UI — 2b/2c (2a only
  logs/degrades).
- `secretstores.kubernetes` and remote secret stores.
