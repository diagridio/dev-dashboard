# Testing Improvements — Design Spec

**Date:** 2026-06-28
**Status:** Approved (design); pending implementation plan
**Scope:** Items 1–4 of the testing-improvement suggestions for `dev-dashboard`.

## Background

`dev-dashboard` is a passive, single-binary observer of local Dapr development. Its
core risk is that it parses data shapes it does not own:

- Dapr durabletask **workflow state** (proto-encoded history + metadata) read directly
  from state-store backends (Redis / PostgreSQL / SQLite).
- The Dapr sidecar **`/v1.0/metadata`** and **`/v1.0/healthz`** HTTP responses used for
  app discovery enrichment.

Today every test mocks at the HTTP or store layer. Two integration tests exist
(`pkg/statestore/store_integration_test.go`, `pkg/workflow/workflow_integration_test.go`)
using in-process miniredis and a temp SQLite DB, but they are **not run in CI** and they
seed workflow state by hand — so nothing validates the dashboard against state authored by
a real Dapr runtime, and the assembled server wiring (`cmd.runServe`) is never exercised
end to end.

This spec covers four improvements that close those gaps. Items 6 (Playwright/browser e2e),
7 (SSE integration), Redis-backed e2e, and any CI job that installs Dapr are explicitly
**out of scope**.

## Cross-cutting: build-tag taxonomy

Tests are tiered by external dependency. The first two run in CI; the third is local-only.

| Tag | Dependencies | Runs in CI | Examples |
|-----|--------------|-----------|----------|
| `unit` | none | yes (already) | handler tests with fakes, decode unit tests |
| `integration` | in-process only (miniredis, temp SQLite) | **yes (item 1)** | state-store round-trip, golden tests (item 2), full-server wiring (item 3) |
| `e2e` | real `daprd`/`dapr` on PATH | **no** — local-only, skipped when absent | real-runtime workflow read (item 4) |

New `Makefile` targets (the existing `test` / `test-go` / `test-web` targets are unchanged):

```makefile
test-integration:
	gotestsum -- -tags integration -race ./...

test-e2e:
	go test -tags e2e ./...
```

`make test` continues to run only `unit` + web tests, so the default contributor loop stays fast.

---

## Item 1 — Run integration tests in CI

**Goal:** the self-contained integration tests run on every PR so they cannot silently rot.

**Change:** add one step to the existing Go job in `.github/workflows/ci.yaml`, after the
unit-test step, reusing the same Go toolchain and runner (no services required):

```yaml
- run: gotestsum --format testname -- -tags integration -race ./...
```

**Acceptance criteria:**
- The two existing `*_integration_test.go` files (plus the new item-2 and item-3 tests, which
  also carry the `integration` tag) execute on every push and PR.
- A deliberately broken decode or wiring path turns CI red.
- No new external service is provisioned in CI.

---

## Item 2 — Golden files for proto/JSON shapes

**Goal:** pin the exact data shapes the dashboard depends on so Dapr-version drift surfaces as
a readable diff rather than a silent break.

**Layout:**
- `pkg/workflow/testdata/golden/*.golden.json` — decoded-and-serialized workflow API models.
- `pkg/discovery/testdata/golden/*.golden.json` — parsed `/v1.0/metadata` structs.

Golden tests carry the **`integration`** build tag so they run in CI (item 1).

**Workflow decode golden test (`pkg/workflow`):**
1. Seed known proto history + metadata into a temp SQLite store via the existing
   `statestore.SeedForTest` helper and key builders (`statestore.InstancePrefix`, suffix
   constants).
2. Read it back through the real `pkg/workflow` decode/list/get path.
3. Marshal the resulting API model to indented JSON and compare to the committed golden file.

**Metadata parse golden test (`pkg/discovery`):**
1. Feed a captured `/v1.0/metadata` response body (committed under `testdata/`) through the
   real `pkg/discovery` parsing path.
2. Marshal the parsed struct to JSON and compare to its golden file.

**Update mechanism:** a shared helper

```go
func goldenAssert(t *testing.T, name string, got []byte) // compares got to testdata/golden/<name>
```

honors a package-level `-update` flag. Normal runs compare; `go test -tags integration ./pkg/workflow -run Golden -update` rewrites the golden files. The flag is declared once per package (`var update = flag.Bool("update", false, "regenerate golden files")`).

**Provenance:** any fixture captured from a live Dapr sidecar (e.g. the `/v1.0/metadata` body)
is committed with a comment or sibling note recording the Dapr runtime version it came from,
so a future drift can be attributed.

**Acceptance criteria:**
- Golden files are committed and compared on every CI run.
- `-update` regenerates them.
- An intentional shape change produces a clear JSON diff in the failing test output.

---

## Item 3 — Full-server wiring test

**Goal:** exercise the assembled dependency graph that only `cmd.runServe` builds today, so a
wiring regression (unmounted route, mis-detected store, wrong namespace) is caught by a test.

**Observation:** `server.NewRouter(opts)` is already cleanly constructed from `server.Options`
and is well covered by existing per-handler tests using fakes. The genuinely untested code is
the **dependency assembly** in `runServe` (root.go lines ~82–147): scan-path resolution →
`statestore.Detect` → `newStoreBackend` / `newStoreRegistry` (in `cmd/workflow.go`) →
populated `server.Options`.

**Refactor (no behavior change):** extract that assembly from `runServe` into a testable
function in the `cmd` package, e.g.

```go
type serveDeps struct {
	StateStorePath string            // explicit component YAML, or "" to auto-detect
	Namespace      string
	Apps           discovery.Service // injectable so tests can stub the sidecar scan
	HomeDir        string            // injectable so tests don't touch the real ~/.dapr
	HTTPClient     *http.Client
}

func assembleOptions(ctx context.Context, deps serveDeps, dist fs.FS) (server.Options, []func() error, error)
```

`runServe` calls `assembleOptions` and keeps owning process concerns (browser open, signal
handling, `srv.Start`/`Shutdown`). The extraction must preserve current behavior exactly.

**Test (`cmd` package, `integration` tag):**
1. Build `serveDeps` pointing `StateStorePath` at a temp SQLite component YAML (temp DB seeded
   via `statestore.SeedForTest`), a **fake `discovery.Service`** returning one canned app
   (so no real process scan / sidecar is needed), and an injected `HomeDir` temp dir.
2. Call `assembleOptions`, build the router with `server.NewRouter`, serve via `httptest.NewServer`.
3. Drive the real HTTP surface and assert:
   - `GET /healthz` → 200
   - `GET /api/version` → expected version JSON
   - `GET /api/apps` → reflects the fake app
   - `GET /api/workflows?store=…` → returns the seeded workflow through the real
     statestore → workflow → handler path
   - an unknown non-`/api` route → SPA `index.html` fallback
4. Invoke the returned closers in cleanup.

**Acceptance criteria:**
- One test exercises the assembled graph end to end (assembly + router + real read path).
- Removing a route mount or breaking store detection fails the test.
- `assembleOptions` is the single wiring path shared by `main` and the test.

---

## Item 4 — Real-`daprd` e2e test

**Goal:** prove the dashboard reads workflow state authored by a real Dapr runtime — the
assertion hand-seeded proto cannot provide.

**Gating:** new **`e2e`** build tag. The test calls `t.Skip` unless both `dapr` and `daprd`
resolve on PATH. Local-only; not added to CI.

**Workflow app:** a tiny dedicated app under `test/e2e/wfapp/` that registers one trivial
durabletask workflow and activity via the Dapr SDK (e.g. a workflow calling a single activity
that returns a known value). It exists only to make the runtime write real state.

**Test flow (`e2e` tag):**
1. Create a temp dir with a SQLite state-store component YAML (SQLite is the default — no extra
   services).
2. Start the workflow app under `dapr run` (with `--resources-path` pointing at the temp
   component, and the temp dir for state), wait for the sidecar to be healthy.
3. Trigger one workflow instance (via the workflow HTTP API or the app's own trigger endpoint)
   and wait for it to complete.
4. Point the dashboard's real `statestore` + `workflow` readers at the **same** SQLite backend
   and assert the dashboard reads back the instance: its ID, completed status, and history match
   what the runtime wrote.
5. `t.Cleanup` stops the `dapr run` process and removes temp dirs.

**Backend:** SQLite only for now. The test is structured so a Redis parameterization could be
added later, but Redis e2e is out of scope.

**Acceptance criteria:**
- With Dapr installed locally, the test proves the dashboard correctly reads runtime-authored
  workflow state (status + history), not just hand-seeded proto.
- Without Dapr on PATH, the suite skips cleanly (no failure, no hang).
- The `wfapp` is self-contained and started/stopped by the test.

---

## Out of scope

- Item 6: Playwright / browser end-to-end tests.
- Item 7: SSE / log-streaming integration test.
- Redis-backed e2e (item 4 is SQLite-only).
- Any CI job that installs the Dapr CLI/runtime (item 4 stays local-only).

## Summary of changes by area

| Area | Change |
|------|--------|
| `.github/workflows/ci.yaml` | + `integration` test step (item 1) |
| `Makefile` | + `test-integration`, `test-e2e` targets |
| `pkg/workflow` | + golden decode test + `testdata/golden/` (item 2) |
| `pkg/discovery` | + golden metadata-parse test + `testdata/` fixture (item 2) |
| `cmd/root.go`, `cmd/workflow.go` | extract `assembleOptions` from `runServe` (item 3) |
| `cmd` (test) | + full-server wiring test, `integration` tag (item 3) |
| `test/e2e/wfapp/` | + minimal SDK workflow app (item 4) |
| `cmd` or `test/e2e` (test) | + real-`daprd` e2e test, `e2e` tag (item 4) |
