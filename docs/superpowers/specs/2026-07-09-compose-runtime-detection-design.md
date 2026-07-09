# Compose App Runtime Detection — Design

**Date:** 2026-07-09
**Status:** Approved design, pending implementation plan
**Delivery:** follow-up commits on PR #50 (branch worktree-compose-container-identity)

## Problem

The App overview and App detail pages show `runtime: unknown` for
docker-compose Dapr apps whenever the app image is a locally built one
(e.g. `dapr-mq-daprmq-host-1`). Today's only compose signal is
`InferRuntimeFromImage(AppImage)`, which needs a recognizable base-image
name. The four reference services (`dapr-mq` stack, .NET) all show
"unknown".

## Goals

1. Compose apps show a real runtime on the overview and detail pages
   whenever any local signal reveals it.
2. Zero extra container-runtime calls: reuse the batched `docker inspect`
   discovery already performs.
3. Best-effort and silent: no signal → "unknown", never an error or log
   noise on the 2s scan cadence.
4. No frontend changes — both pages already render `runtime`.

## Chosen approach (B)

Container signals first, compose build-context marker files as the last
fallback. Rejected alternatives:

- **Container signals only:** zero file I/O, but misses Go apps in
  scratch/distroless images with a bare-binary entrypoint and no env
  markers.
- **Compose-file/local-paths only:** misses services that use pulled
  images (no `build:` section, no local path) — exactly the case container
  signals handle for free — and does file I/O even when the entrypoint
  already says `dotnet`.

## Design

### 1. Signal capture

`pkg/discovery/compose_inspect.go` — `composeContainer` gains:

- `Env []string` from `Config.Env`
- label reads: `com.docker.compose.project.config_files` and
  `com.docker.compose.project.working_dir`

`pkg/discovery/scan_compose.go` — when the app container is paired,
`ScanResult` gains `AppRuntime string`, computed at scan time by a
short-circuiting chain (stop at the first non-"unknown"):

1. `InferRuntime(app container argv, joined)` — existing; catches
   `dotnet X.dll`, `python app.py`, `node server.js`, `java -jar`.
2. `InferRuntimeFromEnv(app container env)` — new in
   `pkg/discovery/infer.go`. Env-name markers inherited from official base
   images: `DOTNET_VERSION`/`ASPNET_VERSION` → dotnet; `NODE_VERSION` →
   node; `PYTHON_VERSION` → python; `JAVA_VERSION`/`JAVA_HOME` → java;
   `GOLANG_VERSION` → go; `RUST_VERSION`/`CARGO_HOME` → rust.
3. `InferRuntimeFromImage(app image)` — existing.
4. `runtimeFromBuildContext(...)` — section 2; only reached when 1–3 all
   fail, so file I/O happens only for bare-binary/scratch cases. The
   scan's existing 2s cache TTL bounds how often it can run.

### 2. Build-context marker resolver

New file `pkg/discovery/compose_runtime.go`:

```go
runtimeFromBuildContext(configFiles, workingDir, service string) string
```

- `configFiles` is the raw label value — comma-separated when the project
  was started with multiple `-f` files; parse each in order, first hit
  wins. Files must exist locally; a stack started on another host silently
  yields "unknown".
- Minimal YAML parse (`sigs.k8s.io/yaml`, existing direct dependency):
  only `services.<service>.build`, honoring both compose forms — string
  shorthand (`build: ./dotnet`) and object (`build: {context: ./dotnet}`).
  No `build:` section (pulled image) → "unknown" immediately.
- Resolve the context path relative to `workingDir` (the
  `project.working_dir` label — the same base compose itself uses).
- Marker scan, top level of the context directory only (one
  `os.ReadDir`):
  - `go.mod` → go
  - `*.csproj` / `*.fsproj` / `*.sln` / `global.json` → dotnet
  - `package.json` → node
  - `pyproject.toml` / `requirements.txt` / `setup.py` → python
  - `pom.xml` / `build.gradle` / `build.gradle.kts` → java
  - `Cargo.toml` → rust
- All failures (unreadable file, YAML error, missing service, dangling
  context path) return "unknown" silently, matching `infer.go`'s
  best-effort idiom.

**Deliberate exception:** the compose-discovery design
(`2026-07-04-compose-discovery-design.md`) ruled out compose-file parsing
*as a discovery source*. This feature reads the file only as a
display-only enrichment hint after runtime-truth signals (the running
container) have failed; discovery correctness never depends on it.

### 3. Consumption

`pkg/discovery/service.go` `enrich`, compose branch: if `Runtime` is
"unknown", use `r.AppRuntime`; if that is empty (fixtures/scanners
predating the field), fall back to the existing
`InferRuntimeFromImage(r.AppImage)` call. Standalone/Aspire paths
untouched.

## Edge cases

| Case | Behavior |
| --- | --- |
| Locally built image, `dotnet X.dll` entrypoint (dapr-mq) | Step 1 resolves "dotnet"; no file I/O. |
| Official base image, script entrypoint | Step 2 env markers or step 3 image name. |
| Go binary in scratch image, `build:` context with `go.mod` | Step 4 resolves "go". |
| Pulled image, unrecognizable name, no env markers | "unknown" (no `build:` to follow). |
| Compose file moved/deleted since `up` | Step 4 fails silently → "unknown". |
| Multiple `-f` config files | Each parsed in order; first service match with a `build:` wins. |
| App container not paired | No argv/env/image signals; `AppRuntime` empty → "unknown". |

## Testing

- `InferRuntimeFromEnv`: table test over marker env names + empty/no-match.
- `runtimeFromBuildContext`: temp-dir fixtures — string and object
  `build:` forms, comma-separated `configFiles`, service without `build:`,
  nonexistent context path, one marker case per runtime including the
  `.sln` + `global.json` dotnet layout mirroring dapr-mq.
- Scanner chain precedence: argv beats env beats image beats
  build-context; all-unknown stays "unknown"; the file step is not reached
  when argv resolves (fixture whose context dir would answer differently).
- `enrich`: compose + unknown → `AppRuntime` used; empty `AppRuntime` →
  image fallback (keeps `TestEnrichComposeCarriesContainerFields` green).
- Full matrix (`make lint` / `make test` / `make build`) plus live check:
  all four dapr-mq apps show **dotnet** on overview and detail.
