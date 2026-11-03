# Replace "Run template" stat card with "Unhealthy" — Design

**Date:** 2026-07-09
**Status:** Approved

## Problem

The Applications overview page has a stats row with five cards: Apps running,
Healthy, Starting, Components loaded, and Run template. The Run template card
picks a single template name via a fallback chain (first app with a
`runTemplate`, else "Aspire" if any Aspire app, else "Compose", else "—").
Since the dashboard now discovers apps from multiple run processes (dapr run
templates, .NET Aspire, docker compose) at the same time, a single-value
"Run template" card is misleading and redundant — the per-row Run template
column already shows the source per app.

## Decision

Replace the Run template stat card with an **Unhealthy** count card.

- Counts exactly `health === 'unhealthy'`. Apps with `unknown` health (e.g.
  compose apps whose sidecar HTTP port is not published) are **not** counted;
  they remain visible in the table with their amber LED.
- Card order becomes: Apps running · Healthy · Starting · Unhealthy ·
  Components loaded.
- The number renders in the fail color (`--fail-fg`) only when the count is
  greater than 0; at 0 it stays the default neutral color.

Alternatives considered and rejected:
- **Run sources summary** (e.g. "CLI · Compose"): keeps provenance info but is
  less actionable; the per-row column already covers it.
- **Distinct runtimes count**: nice-to-know, not actionable.
- **Counting unknown into the card** (or into Starting): makes labels lie;
  an unpublished port is benign and would inflate an alarm-colored number.

## Changes

### `web/src/pages/Applications.tsx`
- Remove the `runTemplate` derivation (the `apps.find(...)` fallback chain)
  and the Run template stat card.
- Add `const unhealthy = apps.filter((a) => a.health === 'unhealthy').length`.
- Add the Unhealthy stat card after Starting:
  `<div className="n bad">` when `unhealthy > 0`, plain `"n"` otherwise;
  label `Unhealthy`.
- The per-row **Run template column and `sourceLabel` logic are unchanged.**

### `web/src/styles/theme.css`
- Add `.stat .n.bad { color: var(--fail-fg); }` next to the existing
  `.stat .n.mint` rule, reusing the same token as `.led.bad`.

### `web/src/pages/Applications.test.tsx`
- Update the stats-row test that asserts `/run template/i` appears in the
  stats row (the table header still contains "Run template", so the assertion
  must scope to the stats row or assert the label count drops to 1).
- Add: with one unhealthy app, the Unhealthy card shows `1` and the number
  element has the `bad` class.
- Add: with zero unhealthy apps, the card shows `0` without the `bad` class.

## Testing

Component tests via vitest as above; run `tsc -b` (vitest does not typecheck).
No backend/API changes.
