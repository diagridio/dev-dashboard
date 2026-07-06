# UI polish: nav order, footer feedback link, lower min width — Design

**Date:** 2026-07-06
**Status:** Approved for planning

Three small, independent UI changes to the web dashboard.

## 1. Top menu: swap Configurations and Resiliency

`NAV_ITEMS` in `web/src/components/TopNav.tsx` currently orders the tabs:

> Applications, Workflows, Actors, Subscriptions, Components, **Configurations, Resiliency**, Control Plane, Logs

Swap the two so Resiliency comes before Configurations:

> Applications, Workflows, Actors, Subscriptions, Components, **Resiliency, Configurations**, Control Plane, Logs

Routes and labels are unchanged; only array order moves. `TopNav.test.tsx` ("has exactly 9 items in the correct order") is updated to the new order.

## 2. Sidebar footer: "Issues & feedback" link

The Resources sidebar footer (`.sbfoot` in `web/src/components/ResourcesSidebar.tsx`) currently renders one line:

> Powered by [Diagrid] · v{version}

Add a second line below it:

> [Issues & feedback]

- Link target: `https://github.com/diagridio/dev-dashboard` (as requested — repo root, not `/issues`).
- Opens in a new tab (`target="_blank" rel="noopener noreferrer"`), matching the Diagrid link.
- Markup: a new element inside `.sbfoot` after the `.pw` span (e.g. `<span className="pw"><a …>Issues &amp; feedback</a></span>` on its own line, or a sibling class if spacing needs it). Styling follows the existing `.pw` mono/muted look; at most a small `theme.css` addition for line spacing.
- Behavior in collapsed sidebar is unchanged: `.app.collapsed .sbfoot { display: none }` already hides the whole footer.

`ResourcesSidebar.test.tsx` footer describe-block gets an assertion for the new link's name and href.

## 3. Lower the small-screen warning threshold to 768px

`web/src/components/SmallScreenGuard.tsx` shows a full-screen "designed for a wider screen" overlay below `MIN_WIDTH = 1024`. Change the constant to **768** (75% of 1024).

- The guard only checks width, so "75% of current size" maps to width only.
- Existing responsive CSS already adapts below 1024px (sidebar collapse media query at 760px, two-column collapses at 820/760/720px), so no additional layout work is required for the newly-allowed 768–1023px range. Spot-check the main pages at ~800px width during verification.
- `SmallScreenGuard.test.tsx` mocks `matchMedia` boolean-only; add a small assertion that the media query string uses `768px` so the threshold is pinned by a test.

## Out of scope

- Any layout redesign for narrow widths beyond what existing CSS provides.
- Height-based guarding.

## Testing

Unit tests as noted per change (Vitest). Full `web` test suite + lint + build must pass. Manual verification: run the dashboard, confirm nav order, footer link, and that resizing to ~800px width no longer triggers the overlay while ~700px does.
