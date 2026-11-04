# Dapr 1.19 building blocks: catalog refresh + workflow data references

Date: 2026-11-04
Branch: `feat/dapr-1-19-building-blocks`

## Intent

Dapr 1.19 added three alpha building blocks — **Binary Store** (`binarystore.*`),
**Search** (`search.*`) and **Vector** (`vector.*`). The dashboard should:

1. know about their components (catalog refresh), so they can be built and inspected
   like any other component, and
2. stay useful when .NET / JavaScript apps use the 1.19 **workflow data references**
   feature: those SDKs offload large workflow payloads to a binary store and put a small
   `$daprRef` JSON envelope in workflow history instead. Today the Workflow detail page
   shows that envelope as an opaque blob, so the developer can no longer see what went
   into and out of each step.

Background research (protos, contrib interfaces, upstream proposals) is summarised in the
conversation that produced this spec; the relevant upstream documents are
dapr/proposals#88 (Binary Store), #107 (Search & Vector) and #109 (workflow data
reference envelope, normative v1 format).

## Goals

1. **Catalog refresh.** `pkg/metadata/component-metadata-bundle.json` updated to the
   components-contrib **v1.19.0** release asset. The catalog then contains 6 `binarystore`,
   2 `search` and 2 `vector` entries (plus one new binding).
2. **New categories work end to end** in the component builder and Components list.
   Investigation showed both are fully data-driven (categories come from
   `Object.keys(byType)`; no hardcoded category list or icons), so this item is
   *verification + tests*, not new UI.
3. **`$daprRef` envelopes on the Workflow detail page** are recognised and rendered as a
   reference card showing **store**, **key** and **size**, with a **Load payload** button
   that fetches the real bytes and shows them in place.

## Non-goals

- Browsing Search indexes / Vector collections / binary store files (item 4 of the
  research; later).
- Any write or delete against a binary store (including cleaning up offloaded payloads on
  purge). The dashboard stays read-only here.
- Talking to cloud storage (S3, Azure Blob, GCS, OCI) directly. Bytes come only through a
  Dapr sidecar.
- Envelope handling in the Replay easter egg / `HistoryPanel`, the Workflows list, or
  the Stats view.
- Supporting `stages` (compression/encryption). No SDK emits them yet.
- Uploading through the gRPC streaming API (only the read stream is used).

## Anti-goals

- Treating an ordinary app object that merely *contains* a `$daprRef` key as a reference
  (would hide real data).
- Silently showing nothing / spinning forever when the sidecar can't serve the file — the
  user must see why.
- Loading huge payloads into the browser unbounded.

## Constraints

- Follow AGENTS.md: domain logic in `pkg/<domain>`, HTTP wiring in `pkg/server` (one file
  per domain), no `cmd/` imports from `pkg/`, UI follows `web/STYLEGUIDE.md` tokens/classes.
- The new proxy is **read-only** (`GET` to the sidecar only), so it does not extend the
  AGENTS.md mutating-operations list. Update AGENTS.md / ARCHITECTURE.md only to mention the
  new read path if those docs enumerate sidecar calls.
- Gates: `make test`, `make build` (tsc), and `make test-integration` because server wiring
  changes. Golden catalog summary regenerated with
  `go test -tags integration ./pkg/metadata -run Golden -update` (the golden test is
  integration-tagged).
- Verify end to end once against a real 1.19 sidecar with a `binarystore.in-memory`
  component (or the .NET/JS SDK data-references sample) before calling it done.

## Decided design

### 1. Catalog refresh

- Run `scripts/update-component-metadata-bundle.sh v1.19.0`.
- Regenerate `pkg/metadata/testdata/catalog-summary.json` via the golden test's `-update`.
- Fix any processing fallout in `pkg/metadata` (dedupe / deprecated filtering / sorting)
  surfaced by the new entries; review the diff of the summary for surprises (removed or
  renamed components between the June snapshot and v1.19.0).

### 2. New categories in builder & Components list

- Add tests asserting `binarystore`, `search`, `vector` appear as category chips in
  `StepType` and that selecting e.g. `binarystore` → `aws.s3` produces a configure form and
  YAML with `type: binarystore.aws.s3`.
- Manually verify (headless Chrome screenshot tip from memory) that the chip row still fits
  at the 768px minimum width with three more chips; if it overflows, wrap the row.
- Components list already shows `type · version` from the resource; no change expected.

### 3. Workflow data references

**Envelope detection** (frontend, `web/src/lib/daprRef.ts`), following proposal #109:

1. Trim leading whitespace; if it doesn't start with `{` → ordinary data.
2. JSON-parse. On failure: ordinary data, unless the text contains `$daprRef` → **invalid**.
3. Parsed value must be an object with exactly one property `$daprRef`, else ordinary data.
4. Validate: `v === 1`; `store`, `key` non-empty strings after trim; `size` non-negative
   integer ≤ 2^53−1; `sha256` matches `^[0-9a-f]{64}$`; `stages` optional array of
   `{n: string, m?: Record<string,string>}`. Any failure → **invalid**.

Result type: `{kind:'data'} | {kind:'ref', ref} | {kind:'invalid', reason}`.

**Where:** every payload site rendered on `WorkflowDetail`: workflow input, output,
custom status, and per-event input/output in `EventRow`. Implement as one shared component
(e.g. `PayloadView`) that replaces the current `<pre className="json">{highlightJson(x)}</pre>`
blocks, so all sites behave identically.

**Reference card (unloaded):** label "Stored in binary store", then store, key (monospace,
copyable), size (human-readable, e.g. `128.0 KiB`, with exact bytes in a tooltip), and a
**Load payload** button. The existing copy button for that panel copies the envelope JSON.
If `stages` is non-empty, the button is disabled with "staged payloads (…names) are not
supported".

**Invalid envelope:** show the raw text as today, with a small warning note
"Invalid data reference: <reason>".

**Backend** — new read-only endpoint. Domain logic in a new `pkg/binarystore` package
(`service.go`), HTTP wiring in `pkg/server/binarystore.go`:

`GET /api/apps/{appId}/binarystore/{store}/file?key=<key>&size=<declared size>`

(`key` is a query parameter because SDK keys contain `/`, e.g.
`workflow-payloads/<instanceId>/<sha256>`.)

- Resolve the instance with `svc.Get(appId)` → 404 "app not found"; `!SidecarReachable` →
  503 "sidecar unreachable". With several instances of one appId (compose replicas), the
  first match is fine — they share components.
- If the instance's loaded components (`in.Components`) have no component named `store`
  with a `binarystore.` type → 400 "binary store component '<store>' is not loaded by
  <appId>".
- **Transport: sidecar gRPC, not HTTP.** Call `GetBinaryFileAlpha1` (server-streaming,
  `dapr/dapr/pkg/proto/runtime/v1`, module already in `go.mod` at v1.19.0) on the
  instance's gRPC port, reusing the existing lazy connection pool in
  `pkg/workflow/sidecar.go` (`SidecarPool`) — extract/share it rather than opening a second
  pool. Reason (verified in dapr v1.19.0 source): the HTTP route is
  `/v1.0-alpha1/binarystore/{name}/{fileName}` with `{fileName}` a single chi segment, and
  `binaryStoreNames` reads the chi param without unescaping, so a key with `/` either
  doesn't route or arrives with a literal `%2F`. gRPC takes `file_name` as a plain string.
  Map gRPC codes: `NotFound` → 404 "file not found in <store>", `InvalidArgument` → 400,
  `Unavailable` → 503, else 502, with the status message.
- No preview-feature gate exists for the API in v1.19.0 (checked: no feature check in
  `pkg/api/universal/binarystore.go`); a sidecar older than 1.19 returns `Unimplemented` →
  400 "this sidecar's Dapr version has no binary store API (requires 1.19+)".
- **Size cap 1 MiB**: if declared `size` > 1 MiB, reject before calling the sidecar; also
  stop reading once received bytes exceed 1 MiB (cancel the stream). Both return 413 with
  `{error, size}`; the UI shows "Payload is N — too large to show here (limit 1 MiB)". The
  client also checks the declared size and shows that message without calling.
- Response: the raw bytes with `Content-Type: application/octet-stream`; the client does
  hashing and decoding. 10 s timeout per request.

**Which sidecar:** the workflow's own app (`appId` from the route). The detail page
already loads the apps list; if the app isn't currently discovered/running, the button is
disabled with "Start <appId> to load this payload". Cross-app references whose store isn't
on that sidecar surface the 400 above.

**After load:**
- Compute SHA-256 in the browser (`crypto.subtle.digest`) over the received bytes and
  compare with `sha256` → show **verified** or **hash mismatch** (mismatch still shows the
  content, with a warning).
- Decode as UTF-8 (fatal). If it parses as JSON → existing `highlightJson` + copy button
  copies the resolved payload. If valid UTF-8 but not JSON → plain `<pre>`. If not valid
  UTF-8 → "Binary payload (N bytes) — not shown".
- A **Hide** / collapse control returns to the reference card. Loaded content is cached per
  `(appId, store, key)` with TanStack Query so re-opening doesn't refetch.
- Errors render inline in the card with a **Retry** button.

## Left to the builder

- Exact component/file names, test file layout, CSS class composition (from existing
  vocabulary), size formatting helper reuse.
- Whether the copy button offers both envelope and resolved payload once loaded.
- Wording polish of messages above.
- RUM: whether to add an action name for "load payload" (follow existing RUM conventions if
  other buttons are tracked).
