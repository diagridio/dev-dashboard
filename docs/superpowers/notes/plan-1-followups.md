# Plan 1 (Foundation) — Deferred Follow-ups

These are the **Minor** findings deferred during Plan 1's subagent-driven implementation
(per-task reviews + the whole-branch review). None block the foundation; address them in a
later UI-polish pass or fold into the relevant feature plan. The whole-branch review's
"fix before merge" items were already applied (asset-404 in `SPAHandler`, static
`web/dist/index.html` placeholder, double-slash opened URL, `gofmt`/`go vet` CI gates).

> **Merged into Plan 2** (Discovery + Applications), no longer tracked here:
> defining the missing CSS tokens (spacing scale + status/health colors) in `theme.css`,
> switching `TopNav`'s active-link highlight to a theme token, `aria-pressed` on *new* toggle
> controls (RefreshControl pause), and the "never `git add web/dist`" guardrail.

## Accessibility
- **Existing Plan-1 toggle buttons lack `aria-pressed`.** `ThemeToggle` and `DensityToggle`
  (`web/src/components/`) don't expose pressed state to AT. (New controls added in Plan 2
  already include it; this is just the two Plan-1 toggles.)
- **Toggle labels show current state, not next action.** `ThemeToggle`/`DensityToggle` render
  "Light"/"Compact" (current value) rather than the action ("Switch to dark"). Inherited from
  the plan's example code; revisit for clarity vs. convention.

## Tooling / build
- **Makefile vs CI test runner mismatch.** `make test-go` runs `go test -tags unit -race ./...`
  while CI installs and runs `gotestsum`. Harmless (same tests) but inconsistent — either make
  `test-go` prefer `gotestsum` when present, or drop `gotestsum` from CI.

## Go
- **`runServe` accepts `ctx` but doesn't use it** (`cmd/root.go`). Will be needed when
  signal-based graceful shutdown lands; wire `ctx` into `Server.Start`/`Shutdown` then.
- **Test-quality / type-precision nits:**
  - `pkg/version` `TestGetDefaults` uses `require.NotNil` on a value struct (no-op); only
    asserts `Version`; `t.Cleanup` restores to literals rather than captured originals.
  - `pkg/server` `get()` test helper swallows the `io.ReadAll` error; the file-serving branch
    uses `r.Clone` where a lighter copy would do.
  - `web` `api.ts` uses `res.json() as Promise<T>` (cast on the Promise, not the value);
    `App.test.tsx` "renders StatusFooter" asserts the role but not the rendered version string.

## Docs
- **Base-path coupling note (README, later plan).** A non-root mount requires the SPA to be
  built with `DASH_BASE_PATH` matching the server's `--base-path` (Vite bakes `base` at build
  time). Document this where install/usage is described (likely Plan 6 / packaging).
