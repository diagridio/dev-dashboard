# Version-update awareness (startup notice + web indicator)

**Status:** Approved design — ready for implementation planning
**Date:** 2026-07-08

## Summary

Make it obvious when a newer dashboard release exists. On startup the CLI resolves
the latest GitHub release, compares it to the running version, and — if a newer one
exists — prints a notice as the first output, with the upgrade command. The web UI
shows a clickable "Update available" indicator next to the version number in the
Resources panel, visible whether the panel is expanded or collapsed.

Both surfaces read from **one shared backend service**, so the web indicator reuses
the startup check's cached result and no duplicate GitHub calls are made.

```
A new version of the Dapr Dev Dashboard is available: v1.2.0 → v1.3.0
Run `dev-dashboard update` to upgrade.

Diagrid Dev Dashboard is running → http://127.0.0.1:9090/
```

## Goals

- A prominent, first-line startup notice when a newer release is available, naming
  the current and latest versions and the exact upgrade command.
- A visual indicator in the web UI next to the version number, in both the expanded
  and collapsed Resources panel.
- Reuse the existing self-update GitHub release resolution; no bespoke duplicate.
- Fail silent and fast: offline, rate-limited, or errored checks produce no notice,
  no badge, and negligible startup delay.

## Non-goals

- **Auto-update.** This is read-only awareness. Upgrading remains the explicit,
  user-initiated `dev-dashboard update` command. (This revisits — narrowly — the
  self-update spec's "no background update checks" non-goal: a lightweight read-only
  *check* is now in scope; automatic *installation* is still not.)
- **Opt-out.** No env var or flag to disable the check. It already fails silently and
  fast, so there is no hard blocker; suppressing the GitHub call on principle is out
  of scope.
- **Prerelease awareness.** The check uses GitHub's `/releases/latest`, which excludes
  prereleases by design.
- **Package-manager installs.** As with `update`, users on Homebrew/Scoop/winget (when
  those exist) upgrade through the package manager; the notice still informs them a
  newer version exists.

## Architecture

One shared backend service resolves and caches the latest release. The CLI calls it
once at startup (blocking, with a spinner); the HTTP server reuses the same instance
to answer a web endpoint the SPA polls. A `dev`/source build has an invalid semver
version, so it is treated as "no update" everywhere — developers never see the notice
or badge.

```
                    ┌─────────────────────────────┐
   startup (once) → │  pkg/updatecheck.Service     │ → GitHub /releases/latest
   GET /api/…     → │  (cached, TTL + neg-cache)   │   (via selfupdate.ResolveLatest)
                    └─────────────────────────────┘
                              │ Result{Current, Latest, UpdateAvailable, ReleaseURL}
                    ┌─────────┴──────────┐
              CLI notice           /api/update-check → web badge
```

## Backend — `pkg/updatecheck` (new package)

A small, isolated domain package following the `pkg/news` pattern (its own
`service.go` + response type, no dependency on `cmd/`).

- **`Result`** — JSON-tagged struct:
  ```go
  type Result struct {
      Current         string `json:"current"`
      Latest          string `json:"latest"`
      UpdateAvailable bool   `json:"updateAvailable"`
      ReleaseURL      string `json:"releaseUrl"`
  }
  ```
- **`Service` interface** — `Check(ctx context.Context) Result`. A caching
  implementation with a ~1h positive TTL and short negative-cache window (mirroring
  `pkg/news`), so the web's polling never hammers GitHub and a failed fetch is not
  re-probed on every request. A failed or errored fetch yields
  `UpdateAvailable: false` and is never surfaced as an error to callers.
- **Comparison** — `golang.org/x/mod/semver` (already in the module graph):
  `UpdateAvailable = IsValid(cur) && IsValid(latest) && Compare(latest, cur) > 0`.
  Both versions are normalized to a leading `v` first. An invalid current version
  (e.g. `dev`) → `false`.
- **Latest resolution** — reuse the existing GitHub `/releases/latest` logic by
  **exporting `selfupdate.ResolveLatest`** (rename the current unexported
  `resolveLatest`). `updatecheck` imports `selfupdate` for this one call rather than
  duplicating the request/parse.
- **`ReleaseURL`** — `https://github.com/diagridio/dev-dashboard/releases/tag/<latest>`,
  pointing at the new release's own notes.

## CLI startup (`cmd/root.go`, `runServe`)

Before the existing "running →" line:

1. If the current version is `dev`/invalid semver → skip entirely (no spinner, no
   network call).
2. Otherwise run the check:
   - If stdout is a TTY (`github.com/mattn/go-isatty` / `golang.org/x/term`, both in
     the module graph), show a `github.com/briandowns/spinner` labeled
     **"Checking for new versions…"**; run `Check` under a **2s timeout** context;
     stop and clear the spinner line.
   - When piped/redirected (non-TTY), skip the spinner animation but still run the
     same bounded check.
3. If `UpdateAvailable`, print the two-line notice; then continue with the existing
   "running →" and telemetry lines. On up-to-date / error / offline, print nothing.

The notice text is produced by a pure, unit-testable helper
`formatUpdateNotice(current, latest string) string` that the startup path writes to
an `io.Writer`. The same `updatecheck.Service` instance built here is passed into the
serve options so the HTTP layer reuses its cache (no second GitHub call).

Notice format:

```
A new version of the Dapr Dev Dashboard is available: <current> → <latest>
Run `dev-dashboard update` to upgrade.
```

## Web — API

- **New endpoint `GET /api/update-check`** returning the `Result` JSON. Wired through
  the server options like `newsSvc` (`apiRouter` gains an `updatecheck.Service`
  parameter). Kept **separate from `GET /api/version`**, which stays pure static build
  info; update-availability is dynamic and network-derived.

## Web — UI

Data flows through one source: `App.tsx` already owns the sidebar `collapsed` state
and applies the `has-new` class from the news hook. It gains a new `useUpdateCheck`
hook result, applies an `update-available` class to `.app` (exactly as `has-new` is
applied today), and passes the result to `ResourcesSidebar` so both the expanded and
collapsed renders read from it.

- **`useUpdateCheck` hook** (`web/src/hooks/useMeta.ts`) — polls `/api/update-check`
  (5-minute interval; the data is stable). Returns `{ current, latest, updateAvailable,
  releaseUrl }`.

- **Expanded state — `.sbfoot`:** when `updateAvailable`, render a clickable badge next
  to `v{version}`: `● Update available ↗`, linking to `releaseUrl`
  (`target="_blank" rel="noopener noreferrer"`), tooltip "v1.3.0 is available", with a
  `trackAction` telemetry call on click. Nothing rendered when up to date.

- **Collapsed state — `.sbvert`:** `.app.collapsed .sbfoot` is `display: none`, so the
  footer badge is hidden when collapsed. Add a parallel indicator in the vertical strip,
  mirroring the existing `#bell-v` / `has-new` mechanism:
  - A small update dot/icon (e.g. `#update-v`) in `.sbvert`, a link to `releaseUrl`
    (`target="_blank"`) with `aria-label`/tooltip "v1.3.0 is available — update".
  - Shown only when collapsed **and** an update is available, via a new
    `theme.css` rule `.app.update-available.collapsed #update-v { display: inline-flex }`
    alongside the existing bell rules, plus the dot styling (per `web/STYLEGUIDE.md`).

This keeps the indicator visible whether the panel is open or closed.

## Testing

- **Go unit (`pkg/updatecheck`)** — table-driven comparison (dev/invalid, equal, newer,
  older); caching + negative caching behavior; release-URL shape. GitHub API served via
  `httptest`.
- **Go unit (`cmd`)** — `formatUpdateNotice` output; startup path writing to a buffer
  with a stub `updatecheck.Service` (asserts the notice is printed when an update exists
  and suppressed otherwise, including the `dev`-version skip).
- **`pkg/selfupdate`** — existing tests updated for the exported `ResolveLatest` (behavior
  unchanged).
- **Server integration** — `/api/update-check` returns the expected JSON from a stub
  service.
- **Web (`ResourcesSidebar.test.tsx`)** — expanded badge visible and linking to
  `releaseUrl` when available, absent otherwise; collapsed-state indicator visible and
  linking to `releaseUrl` when an update is available and the panel is collapsed, absent
  otherwise.

## Edge cases

- **Offline / rate-limited / GitHub error** → `Check` returns `UpdateAvailable: false`;
  no notice, no badge. Negative-cached to avoid re-probing on every request.
- **`dev` / source build** → invalid semver → no notice, no badge, no network call at
  startup.
- **Version normalization** → both current and latest normalized to a leading `v` before
  `semver.Compare`.
- **Startup latency** → bounded by the 2s check timeout; a hung/slow GitHub call cannot
  delay startup beyond that.
