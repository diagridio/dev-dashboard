# Plan 1 (Foundation) — Deferred Follow-ups

These are the **Minor** findings deferred during Plan 1's subagent-driven implementation
(per-task reviews + the whole-branch review). None block the foundation; address them in a
later UI-polish pass or fold into the relevant feature plan. The whole-branch review's
"fix before merge" items were already applied (asset-404 in `SPAHandler`, static
`web/dist/index.html` placeholder, double-slash opened URL, `gofmt`/`go vet` CI gates).

## Accessibility
- **Toggle buttons lack `aria-pressed`.** `ThemeToggle` and `DensityToggle`
  (`web/src/components/`) are toggle buttons but don't expose pressed state to AT.
- **Toggle labels show current state, not next action.** They render "Light"/"Compact"
  (the current value) rather than the action ("Switch to dark"). Inherited from the plan's
  example code; revisit for clarity vs. convention.

## Theming / design tokens
- **Undefined design tokens referenced with inline fallbacks.** `TopNav.tsx`,
  `Placeholder.tsx`, `StatusFooter.tsx`, `Logo.tsx` reference `--space-1/2/4/6`,
  `--nav-height`, `--text-sm`, `--radius-sm`, `--bg-subtle`, `--green`, `--red`, `--logo-ink`
  which are not defined in `web/src/styles/theme.css`. Either define them (preferred — gives a
  real spacing/size scale) or remove the references.
- **Active-nav highlight is hardcoded.** `TopNav` uses a literal `rgba(0,0,0,0.06)`-style
  background for the active link that won't adapt to the dark theme; switch to a theme token
  (e.g. `--bg`/`--surface` + border, as the mockups used).

## Tooling / build
- **Makefile vs CI test runner mismatch.** `make test-go` runs `go test -tags unit -race ./...`
  while CI installs and runs `gotestsum`. Harmless (same tests) but inconsistent — either make
  `test-go` prefer `gotestsum` when present, or drop `gotestsum` from CI.
- **`web/dist/index.html` placeholder ↔ build artifact.** The committed file is a static
  placeholder; `make web`/`make build` overwrites it with a real (hashed-asset-referencing)
  build. Later tasks must NOT `git add web/dist/` (only their src) to avoid committing the
  built file. Consider documenting this in the README.

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
  time). Document this where install/usage is described.
