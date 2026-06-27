# slog-based diagnostic logging with `--verbose`

**Date:** 2026-06-27
**Status:** Approved (design)

## Goal

Give the dashboard its own diagnostic logging so a user can figure out *why the
dashboard itself isn't working*. Logging is **opt-in**: a new `--verbose` flag
turns it on; without the flag the dashboard emits **no** structured logs at all.

The logging focuses on the flows where things actually go wrong:
- starting the HTTP server
- serving the front-end / log-stream (SSE) connections
- finding Dapr processes and applications
- connecting to state stores
- purge / terminate / force-delete of workflow instances

## Non-goals

- No log file / rotation (stderr only).
- No per-HTTP-request access logging (too noisy; not what the flows above need).
- No JSON output format (text only; can be added later if needed — YAGNI).
- No change to existing user-facing output. All current `fmt.Print*` lines stay
  exactly as they are; slog output is **purely additive**.

## Library choice

Go standard library **`log/slog`**. This matches the modern pattern in cloudgrid
(e.g. `services/auditservice` uses `slog` directly) and adds no new dependency.
We deliberately do **not** adopt cloudgrid's legacy `pkg/util/logger` logrus
wrapper, which would pull in that module.

## Flag

A single boolean persistent flag on the root command:

```
--verbose    enable diagnostic logging to stderr (default: false)
```

- `--verbose` set → text handler to `os.Stderr` at `slog.LevelInfo`.
- `--verbose` unset → handler writing to `io.Discard` (calls become cheap no-ops;
  nothing is emitted).

The existing top-level `fmt.Fprintln(os.Stderr, "error:", err)` in `main.go`
still reports a fatal startup error regardless of `--verbose`, so a hard failure
is never completely invisible.

## Architecture

### Logger construction

New package `pkg/logging`:

```go
// New returns a logger. When verbose is false the logger discards everything.
func New(verbose bool) *slog.Logger {
    if !verbose {
        return slog.New(slog.NewTextHandler(io.Discard, nil))
    }
    return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
        Level: slog.LevelInfo,
    }))
}
```

`runServe` builds the logger from the flag and calls `slog.SetDefault(logger)`.

### Wiring (blend of injection + default)

- **`server`** already has an `Options` struct → add a `Logger *slog.Logger`
  field (nil → `slog.Default()`).
- **Leaf packages** (`discovery`, `statestore`, `workflow`) obtain their logger
  via `slog.Default().With("component", "<name>")` so every line carries a
  `component=` scope tag (mirroring cloudgrid's named-logger convention).

Tests can swap the default logger (or pass one in) to assert on output.

## Level semantics

- **INFO** — normal lifecycle milestones worth confirming: server up, N apps
  found, store connected, removal succeeded. Happy-path narration.
- **WARN** — degraded but still working: missing app metadata, a state store
  that failed to init (skipped), no store detected, unavailable log stream,
  force-delete unavailable. "Still running, but you may be missing something."
- **ERROR** — an operation the user asked for failed, or the server can't
  function: listen failure, UI load failure, a purge/force-delete failure.

Because nothing is emitted without `--verbose`, ERROR is **not** always-on; the
`main.go` stderr fatal print covers the truly-invisible case.

## Event mapping

### 1. Server start / lifecycle — `cmd/root.go`, `pkg/server/server.go`

| Level | Message | Attrs | Location |
|---|---|---|---|
| INFO | `server listening` | `addr`, `basePath`, `version` | before `srv.Start()` |
| INFO | `shutdown signal received` | — | `ctx.Done()` branch |
| ERROR | `embedded UI failed to load` | `err` | `web.DistFS()` error |
| ERROR | `server failed to start` | `addr`, `err` | `errCh` returns (e.g. port in use) |
| WARN | `graceful shutdown failed` | `err` | `srv.Shutdown` error |

### 2. Front-end / UI serving + SSE — `pkg/server`

| Level | Message | Attrs | Location |
|---|---|---|---|
| INFO | `serving embedded UI` | `basePath` | router setup, one-time |
| INFO | `log stream opened` | `app`, `source` | SSE client connects |
| INFO | `log stream closed` | `app` | normal disconnect |
| WARN | `log stream source unavailable` | `app`, `path`, `err` | server-side surfacing of the error currently swallowed in `web/src/hooks/useLogStream.ts` |

### 3. Finding Dapr processes & apps — `pkg/discovery/service.go`

| Level | Message | Attrs | Location |
|---|---|---|---|
| INFO | `discovered Dapr apps` | `count` | after `List` |
| WARN | `app metadata unavailable` | `appID`, `httpPort`, `err` | `enrich` when `MetadataOK=false` |
| ERROR | `app scan failed` | `err` | `scan()` returns error |

Per-app health (unhealthy/unknown) is intentionally **not** logged — too noisy
during normal startup races, and already visible in the UI.

### 4. Connecting to state stores — `cmd/workflow.go` (`newStoreBackend`), `pkg/statestore`

| Level | Message | Attrs | Location |
|---|---|---|---|
| INFO | `detected state-store components` | `count` | after `statestore.Detect` |
| INFO | `state store connected` | `name`, `type`, `active` | after `statestore.New` succeeds |
| WARN | `no state store detected` | — | empty detection (workflows run degraded) |
| WARN | `state store init failed, skipping` | `name`, `err` | existing `fmt.Printf("warning:…")` spot — the print stays (additive); a WARN is added alongside |

### 5. Purge / terminate / force-delete — `pkg/workflow/remove.go`

| Level | Message | Attrs | Location |
|---|---|---|---|
| INFO | `workflow removal requested` | `app`, `instance`, `mechanism`, `force` | top of `Remove` |
| INFO | `workflow removed` | `app`, `instance`, `mechanism` | success |
| INFO | `bulk removal complete` | `total`, `ok`, `failed` | end of `RemoveMany` |
| WARN | `force delete unavailable` | `app`, `instance` | `forceDelete` no-store guard |
| ERROR | `workflow removal failed` | `app`, `instance`, `mechanism`, `err` | any mechanism error |

## Testing

- `pkg/logging`: `New(false)` produces a logger that writes nothing; `New(true)`
  writes text to stderr at INFO. Assert via a handler over a `bytes.Buffer`.
- Per-area: inject/replace the default logger with one writing to a buffer and
  assert the expected message + attrs are emitted on the relevant code path
  (e.g. metadata fetch failure → `app metadata unavailable` WARN; removal error
  → `workflow removal failed` ERROR).
- Verify that with the discard logger, no output is produced on any path.

## Files touched (anticipated)

- `pkg/logging/logging.go` (new) + test
- `cmd/root.go` — `--verbose` flag, build logger, `slog.SetDefault`, server start/shutdown logs
- `cmd/workflow.go` — state-store connection logs
- `pkg/server/server.go` + router/SSE handler — `Logger` option, UI/SSE logs
- `pkg/discovery/service.go` — discovery logs
- `pkg/workflow/remove.go` — removal logs
- `README.md` — document `--verbose` and a short troubleshooting note
