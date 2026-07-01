# Logs for Aspire-hosted and standalone `dapr run` apps

**Date:** 2026-07-01
**Status:** Approved (design)

## Problem

The Logs page shows nothing for applications launched via .NET Aspire (`aspire run`),
and for a standalone single-app `dapr run` (i.e. `dapr run` without a `-f` multi-app
run template). Only `dapr run -f <template>` currently produces visible logs.

### Root cause

The Logs feature can only tail **log file paths reported by the Dapr sidecar** through
its `/v1.0/metadata` endpoint (`extended.appLogPath` / `extended.daprdLogPath`):

- `pkg/discovery/metadata.go` copies those two fields into `Instance.AppLogPath` /
  `Instance.DaprdLogPath`.
- `pkg/server/logs.go` returns **404** when the selected path is empty.
- `web/src/pages/Logs.tsx` shows *"No log file — this app was started with `dapr run`
  without `-f`"* when both paths are empty.

The sidecar only fills `appLogPath` / `daprdLogPath` when launched with a **run
template** (`dapr run -f`). Verified empirically against a live Aspire app
(`/v1.0/metadata` returned `appLogPath: None`, `daprdLogPath: None`).

### Where the logs actually are (verified empirically)

| Run mode | Where logs live | Tailable? |
|---|---|---|
| `dapr run -f <template>` | files under `~/.dapr/logs`, reported in metadata | Yes — already works |
| **Aspire** (`aspire run`) | Aspire/DCP session dir: `<sessionDir>/<guid>_out` files | Yes — via DCP session dir |
| **standalone `dapr run`** (no `-f`) | inherited stdout → tty (or a file only if redirected) | Only if redirected to a regular file |

Details confirmed on a running `PrDigest` Aspire app:

- Aspire's orchestrator (DCP) redirects each child resource's stdout/stderr to
  `<sessionDir>/<guid>_out` and `<guid>_err`, with a companion
  `resource-executable-<guid>.log` recording that resource's `Cmd`/`Args`/name.
  - The `dapr run` CLI resource's `<guid>_out` contains the **daprd** runtime log.
  - The `dotnet run` app resource's `<guid>_out` contains the **app** log.
- The DCP **session dir** is discoverable from the process listening on the app port:
  that listener is the `dcp` process, whose command line carries
  `--kubeconfig <sessionDir>/kubeconfig`. The discovery layer already resolves this
  process (`CommandForPort(appPort)` in `pkg/discovery/appproc.go`) during Aspire
  detection.
- A standalone single-app `dapr run` writes **no log files** (`~/.dapr/logs` is not
  created). daprd's stdout/stderr (fd 1/2) inherit from the `dapr run` parent — a tty
  in a normal terminal (not tailable), or a regular file if the user redirected output.
- In the Aspire case, daprd's fd 1/2 are **pipes** to DCP (not the `_out` file), so
  file-descriptor inspection cannot find Aspire logs — the DCP session dir is required.

## Goals

1. Show `daprd` and `app` logs for Aspire-hosted apps.
2. Show logs for a standalone `dapr run` **when its output is a regular file**
   (redirected or supervised).
3. Keep `dapr run -f` working unchanged.
4. Render DCP-captured lines cleanly (no seq/timestamp prefix noise, no raw ANSI codes).

## Non-goals

- Actively capturing stdout of an already-running terminal `dapr run` whose output is a
  tty (fundamentally no file to read). Such apps continue to show a clear message.
- Reworking the dashboard to launch/supervise dapr processes.
- Parsing `AppHost.cs` source (rejected: fragile to arbitrary C#; runtime data suffices).
- Querying the DCP API server via kubeconfig (rejected: needs a Kubernetes-style TLS
  client; heaviest to build/maintain).

## Design

### 1. Layered log-source resolution (`pkg/discovery`)

Add a resolution step in `service.enrich()` that runs **only when the metadata log paths
are empty**, trying resolvers in priority order and recording the format of each source.

**Resolver order:**

1. **Metadata** (existing) — `extended.appLogPath` / `daprdLogPath`. Format = `plain`.
   Covers `dapr run -f`.
2. **DCP resolver** (Aspire) — used when the app-port listener is the DCP proxy
   (already detected in `appproc.go`):
   - Parse `--kubeconfig <dir>/kubeconfig` from that listener's command line → DCP
     **session dir**.
   - Enumerate `resource-executable-*.log` in the session dir. Parse each file's JSON to
     obtain the resource name (`Executable`), `Cmd`, and `Args`. The `<guid>` in the
     filename maps directly to the `<guid>_out` stdout file.
   - **daprd log** = the resource whose `Cmd` basename is `dapr`/`daprd` and whose `Args`
     contain `run` and `--app-id <appId>` → its `<guid>_out`. Format = `dcp`.
   - **app log** = strip the trailing `-dapr-cli-<suffix>` from that daprd resource's name
     to get the base name, then find the sibling executable resource sharing that base
     (the app resource) → its `<guid>_out`. Format = `dcp`. Robust to app-id ≠
     resource-name.
3. **FD resolver** (standalone `dapr run`) — used when still empty and not Aspire:
   - Inspect the `daprd` process (`DaprdPID`) stdout (fd 1) via `lsof -p <pid> -a -d 1
     -F ftn`. If it resolves to a **regular file** (lsof type `REG`, not `CHR`/tty, not
     `PIPE`), use it. Format = `plain`.
     - Note: gopsutil `OpenFiles()` returns "not implemented" on darwin, so `lsof` is
       used directly. lsof is standard on macOS and Linux.
   - App log: inspect the app process (`AppPID` from metadata, when > 0) stdout the same
     way. Format = `plain`. Deriving the app PID by walking `CLIPID` children is out of
     scope for v1; when `AppPID` is unknown the app source simply has no log.
   - If the fd is a tty/pipe with no backing file, leave the path empty (no log).

**New code:**

- `pkg/discovery/types.go`: add `AppLogFormat` and `DaprdLogFormat` fields to `Instance`
  (`"plain"` | `"dcp"`, default `"plain"`).
- `pkg/discovery/logsource.go` (new): `dcpSessionDir(listenerCmd string) (string, bool)`,
  `resolveDCPLogs(sessionDir, appID string) (daprdPath, appPath string)`,
  `parseLsofStdout(out []byte) string`, `lsofStdoutFile(pid int) string`. The service
  holds an injectable `stdoutFile func(pid int) string` seam (default `lsofStdoutFile`) so
  the FD path can be unit-tested without real processes.
- `pkg/discovery/service.go`: add a `stdoutFile` field (defaulted in `New`), and wire a
  `resolveLogSources(*Instance)` step into `enrich()` after the metadata fetch. Reuse the
  app-port listener command (via `appProc.CommandForPort`) rather than resolving twice.
- `metadata.go` is unchanged.

### 2. Backend normalization (`pkg/server/logs.go`)

- Add `normalizeLine(line, format string) string`, applied in the SSE streaming loop in
  `logs.go`, which already knows the chosen source and can read its format from the
  `Instance` (`DaprdLogFormat` for `source=daprd`, `AppLogFormat` for `source=app`):
  - `dcp`: strip the leading `^\d+\s+\S+Z\s+` (sequence number + RFC3339-UTC timestamp)
    prefix, then strip ANSI escape sequences (`\x1b\[[0-9;]*m`). daprd lines collapse back
    to the standard `time=… level=… msg=…` format the frontend already parses; app lines
    become clean text. The DCP timestamp is discarded (matches existing sources).
  - `plain`: strip ANSI escapes only (harmless), no prefix stripping.
- `pkg/logs/tail.go` stays generic and returns raw lines; the transform lives in the
  handler.

### 3. Frontend (`web/src`)

- No functional change: `hasPath` and the SSE stream in `useLogStream.ts` / `Logs.tsx`
  work as soon as the backend populates `appLogPath` / `daprdLogPath`.
- Update the "No log file" message copy so it is accurate for the genuine tty case, e.g.
  *"No captured log file — this app streams logs to its terminal."*

## Testing

**Unit tests:**

- `dcpSessionDir`: parses the session dir from a sample `dcp … --kubeconfig
  <dir>/kubeconfig …` command line; returns `false` for non-DCP commands.
- `resolveDCPLogs`: given a temp dir containing sample `resource-executable-*.log` files
  (with representative JSON) and matching `<guid>_out` files, returns the correct daprd
  and app paths. Includes a case where the Dapr app-id differs from the Aspire resource
  name.
- `normalizeLine`: DCP daprd sample → standard `time=…` line; DCP app sample (with ANSI)
  → clean text; plain line with ANSI → ANSI stripped; plain line without ANSI → unchanged.
- `parseLsofStdout`: returns the path for a `tREG` record; returns `""` for `tPIPE` and
  `tCHR` (tty) records.
- `resolveLogSources` (FD path): with an injected `stdoutFile` seam, populates
  `DaprdLogPath` from a regular-file stdout and leaves it empty when the seam returns `""`.

**Manual verification:**

- Against the live `PrDigest` Aspire app: select the app on the Logs page, confirm both
  the `daprd` and `app` sources stream and render cleanly.
- `dapr run --app-id x … > app.log 2>&1`: confirm logs appear via the FD resolver.
- A `dapr run -f` template app: confirm it still works (no regression).

## Constraints & risks

- **Host access required.** DCP file reads and FD inspection require the dashboard to run
  on the host with access to the same filesystem and process namespace as the
  dapr/Aspire processes. This is already true — discovery relies on host process/port
  scanning (`standalone.List`, gopsutil) — but the feature will not work if the dashboard
  runs inside a container without the relevant host mounts.
- **DCP session dir is per-run and ephemeral.** It must be re-resolved on each discovery
  pass (resolution runs per `List`/`Get`, so no stale caching).
- **Combined redirect.** If a standalone `dapr run` redirects both daprd and app to the
  same file, both sources point at the same combined log — acceptable.
- **DCP file permissions.** `_out` files are user-owned (0600); the dashboard runs as the
  same user locally, so reads succeed.
