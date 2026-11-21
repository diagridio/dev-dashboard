# Promotion banner — design

Date: 2026-11-21 · Size: small change

## Intent

Diagrid sometimes has something time-sensitive to tell dashboard users (first case: the
[Advent of Workflow](https://www.diagrid.io/advent-of-workflow) event). A small banner floats in
when the dashboard opens, is easy to close, and stays closed for that promotion. A new promotion
shows the banner again. Content is configured in the same place as the Resources menu content:
the diagrid.io product feed.

**Goals:** visible without being in the way; zero dashboard releases needed to change or end a promotion.
**Non-goals:** multiple promotions at once, images, rich text, per-user targeting.
**Anti-goals:** blocking or covering work in a way that annoys a developer mid-debug; a banner
that lingers after the event is over; nagging after it was closed.

## Approaches considered

- **Content source**
  - **A. New `promotion` object in the product feed** — *picked.* Explicit, has an end date and an id that controls re-showing. Costs a website-feed change (agreed).
  - B. Reuse the first `upcomingEvents` item — no feed change, but promotes every event and can't promote non-events.
  - C. `featured: true` flag on existing items — smaller feed change, mixes concerns, no end date.
- **Presentation**
  - **1. Bottom-right floating toast** — *picked.* Doesn't touch nav or layout; works at 768px.
  - 2. Full-width strip under the top bar — most visible, but shifts every page (topbar-overlap risk).
  - 3. Card at the bottom of the sidebar — quietest, but easy to miss and hidden by Ctrl+B.

## Feed contract (for the website team)

New optional top-level field in `https://www.diagrid.io/api/product-feed`:

```json
"promotion": {
  "id": "advent-of-workflow-2026",
  "title": "Advent of Workflow is live",
  "text": "25 days of Dapr Workflow challenges",
  "url": "https://www.diagrid.io/advent-of-workflow",
  "cta": "Join now",
  "startsAt": "2026-12-01T00:00:00Z",
  "endsAt": "2026-12-25T23:59:59Z"
}
```

- Required: `id`, `title`, `url` (http/https). Optional: `text`, `cta` (default "Learn more"),
  `startsAt`, `endsAt` (RFC 3339; a bare `YYYY-MM-DD` is also accepted).
- `null` or absent → no banner. Changing `id` re-shows the banner to everyone who closed the old one.

## Design

**Backend (`pkg/news`).** Add `Promotion` to the feed payload and to `Response` (`promotion`
in `GET /api/news`). The time window is checked on every `Get`, not at fetch time, so a promotion
disappears at `endsAt` even within the 1-hour cache. Drop the promotion when a required field is
missing or the URL isn't http(s). Caching, last-good and singleflight behaviour are unchanged.

**Frontend.** A `PromoBanner` component mounted once in the app shell, reading `useNews()`.

- Shown when the feed has a promotion whose `id` is not in localStorage key
  `devdash.promoDismissed` (via `safeGet`/`safeSet`, like `newsSeen.ts`).
- Slides in from the bottom-right ~1 s after load; no animation under `prefers-reduced-motion`.
  Stays until closed. On a reload it floats in again until closed.
- Closing: ✕ button (`aria-label="Dismiss promotion"`) or Escape while focus is inside the
  banner. Clicking the link opens it in a new tab and also counts as closing it.
- Not shown on the Replay page or in kiosk mode; nothing shown if the feed is unreachable.
- Styled with existing theme tokens and class vocabulary (STYLEGUIDE); external link with ↗ on
  the right; light and dark themes.
- RUM actions via `trackAction`: `promo_shown`, `promo_click`, `promo_dismiss`, each with `{ id }`.

**Tests.** Go unit tests in `pkg/news`: promotion passed through, filtered before `startsAt` /
after `endsAt`, dropped on missing fields or non-http URL, absent → null. Vitest: shows when
undismissed, hidden when dismissed id stored, re-shows for a new id, close and link-click persist
the id, hidden on Replay. `make build` for the typecheck.

## Left to the builder

Exact animation timing and toast width; component/file names; where in the shell it mounts.

## Rollout

The dashboard can ship before the feed changes — no `promotion` field means no banner. Once the
website team adds the field, the banner appears within the feed's 1-hour refresh.
