# Favicon and Document Title Fix — Design

## Problem

1. The dashboard has no favicon — no file exists and `web/index.html` has no `<link rel="icon">`.
2. The browser tab title doesn't reliably reflect the current page after navigating via the top nav. It should always end with ` | Diagrid Dev Dashboard`.

## 1. Favicon

- Source: the green D-glyph `<path>` in `web/src/components/Logo.tsx` (`fill="#41BD9B"`, the first `<path>` in the SVG, source `viewBox="0 0 176 55"`).
- Create `web/public/favicon.svg` containing just that path, with the `viewBox` cropped tightly around the glyph's bounding box (roughly `x: 0–14.4, y: 0–41` in source coordinates) and a transparent background.
- `web/public/` does not currently exist — Vite serves anything under `public/` from the site root automatically, no config changes needed.
- Add to `web/index.html`'s `<head>`:
  ```html
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  ```
- SVG only — no PNG/ICO fallback (internal dev tool, modern browsers only).

## 2. Document title fix

### Root cause

`useDocumentTitle(title)` (`web/src/lib/useDocumentTitle.ts`) is called per-page in a mount effect, with a cleanup that restores whatever title existed before that page mounted. It is called from `ControlPlane.tsx`, `Actors.tsx`, `Resiliency.tsx`, `Logs.tsx`, `Subscriptions.tsx`, and `ResourceList.tsx`, but **not** from:

- `Applications.tsx` (index route `/`)
- `AppDetail.tsx` (`apps/:appId`)
- `Workflows.tsx` (`workflows`)
- `WorkflowDetail.tsx` (`workflows/:appId/:instanceId`)
- `component-builder/ComponentBuilder.tsx` (`components/new`)
- `resiliency-builder/ResiliencyBuilder.tsx` (`resiliency/new`)

Navigating to any of these six leaves the title set by whatever page was visited previously (or the static `Dev Dashboard` from `index.html` on first load).

Separately, `Logs.tsx` has a hardcoded `'Logs — Dapr Dev Dashboard'` fallback branch that predates this fix and doesn't match the desired suffix.

### Fix

- Move the branding suffix into the hook itself, so every caller gets it automatically and consistently:
  ```ts
  document.title = `${title} | Diagrid Dev Dashboard`
  ```
- Add `useDocumentTitle(...)` calls to the six pages listed above, following the existing `—` convention used by `Actors.tsx`/`Subscriptions.tsx`/`Logs.tsx` for dynamic titles:

  | Page | Title expression |
  |---|---|
  | `Applications.tsx` | `'Applications'` |
  | `AppDetail.tsx` | `app.appId` (once the app has loaded) |
  | `Workflows.tsx` | `'Workflows'` |
  | `WorkflowDetail.tsx` | `` `Workflow — ${instanceId}` `` |
  | `component-builder/ComponentBuilder.tsx` | `'New component'` |
  | `resiliency-builder/ResiliencyBuilder.tsx` | `'New resiliency policy'` |

- Simplify `Logs.tsx`'s title logic: drop its own suffix, keep the `isCpView`/`appId` branches, and use plain `'Logs'` for the no-filter fallback (the hook now appends the suffix).
- Update `useDocumentTitle.test.tsx` to assert the new `" | Diagrid Dev Dashboard"` suffix behavior.

## Testing

- Extend/adjust `useDocumentTitle.test.tsx` to cover the suffix.
- For each of the six pages gaining a title call, add or extend a test asserting `document.title` after render (following the pattern already used for pages like `Actors.test.tsx`/`Subscriptions.test.tsx`, if such assertions exist there — otherwise a minimal new assertion).
- Manual check: click through every top-nav route and confirm the tab title updates each time and ends with ` | Diagrid Dev Dashboard`.

## Out of scope

- No change to the router-level title architecture (e.g. route `handle` metadata) — the existing per-page hook pattern is kept and extended.
- No PNG/ICO favicon fallback.
- No change to the visible `Dev Dashboard` app name shown in the top nav (`TopNav.tsx`) — only the document `<title>` and favicon are affected.
