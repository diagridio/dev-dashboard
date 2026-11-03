# React 18 → 19 Upgrade — Design

**Date:** 2026-06-30
**Scope:** Version bump of the `web/` React app to React 19, plus targeted adoption of React 19 features where they cleanly simplify existing code.

## Background

The `web/` interface is a Vite + TypeScript SPA currently on `react@^18.3.1`. A pre-upgrade audit shows the codebase is already React-19-ready:

- Mounts via `createRoot` (`src/main.tsx`) — no legacy `ReactDOM.render`.
- No `forwardRef`, `defaultProps`, `propTypes`, string refs, or legacy context (`contextTypes`/`childContextTypes`).
- `react-router-dom@6` already opts into `future={{ v7_startTransition: true }}`.

Because of this, the upgrade is primarily a dependency bump with peer-compatibility verification, not a code migration. Feature-adoption opportunities are deliberately limited to avoid invented work (YAGNI).

## Part A — Version Bump (core work)

Update `web/package.json`:

| Package | From | To |
|---|---|---|
| `react` | `^18.3.1` | `^19` |
| `react-dom` | `^18.3.1` | `^19` |
| `@types/react` | `^18.3.5` | `^19` |
| `@types/react-dom` | `^18.3.0` | `^19` |

- Reinstall and regenerate `web/package-lock.json`.
- Peers stay as-is — all already support React 19:
  - `@tanstack/react-query@5`
  - `react-router-dom@6`
  - `@testing-library/react@16`
  - `@vitejs/plugin-react@6`
- Optionally run React's official `types-react-codemod` to mechanically catch type-only breakages, then review the diff.

Expected friction: `@types/react@19` tightens some types (e.g. `ReactNode`, stricter `useRef` initial-arg requirement — already satisfied here). Fix only what `tsc` flags.

## Part B — Feature Adoption (deliberately small)

Real candidates found in the codebase:

1. **Context-as-provider** — `src/lib/refresh.tsx`: replace `<RefreshContext.Provider value={…}>` with `<RefreshContext value={…}>`. Apply the same change in `src/components/LiveIndicator.test.tsx`.
2. **`use()` hook** — `src/lib/refresh.tsx`: replace `useContext(RefreshContext)` with `use(RefreshContext)`. (Included per user approval.)

### Deliberately excluded (with rationale)

- **Actions / `useActionState` / `useOptimistic`** — no real `<form>` elements or `useMutation` in components; no clean application site.
- **ref-as-prop** — zero `forwardRef` usages; nothing to migrate.
- **`<title>` / document metadata hoisting** — `useDocumentTitle` does save-on-mount / restore-on-unmount, which native `<title>` hoisting does not replicate cleanly. Keep the hook.

## Testing & Verification

- `npm run build` (runs `tsc -b` then `vite build`) must pass.
- `npm test` (vitest) must pass.
- Manual smoke test via `npm run dev` — React 19's StrictMode double-invoke and effect-timing changes can surface runtime issues that types and tests miss. Verify live-refresh indicator and routing in particular.

## Risk

Low. Part A is a clean dependency diff; Part B is two small, well-isolated edits in `refresh.tsx` plus one test update.
