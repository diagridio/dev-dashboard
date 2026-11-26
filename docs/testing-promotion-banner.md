# Testing the promotion banner locally

The promotion banner (bottom-right of the dashboard) and the Resources menu's news slots both
come from the diagrid.io product feed (`https://www.diagrid.io/api/product-feed`). To try the
banner with your own content, point the dashboard at a local feed with
`DEVDASHBOARD_NEWS_FEED_URL`.

Design: [`docs/specs/2026-11-21-promotion-banner-design.md`](specs/2026-11-21-promotion-banner-design.md).

## Quick start

```sh
make build

# Copy the fixture so your edits don't change the committed file.
cp test/fixtures/promotion/product-feed.json /tmp/product-feed.json

DEVDASHBOARD_NEWS_FEED_URL=/tmp/product-feed.json ./bin/diagrid-dev-dashboard --port 9191
```

The startup output confirms the override:

```text
News feed override (DEVDASHBOARD_NEWS_FEED_URL): /tmp/product-feed.json, re-read every 5s.
```

The banner slides in about 1 second after the page loads. If it never appears, check that `--no-promotion` / `DEVDASHBOARD_NO_PROMOTION=true` isn't set; it removes `promotion` from `/api/news`.

## `DEVDASHBOARD_NEWS_FEED_URL`

| Value | Example |
|---|---|
| Path to a JSON file (absolute or relative to the current directory) | `/tmp/product-feed.json` |
| `file://` URL | `file:///tmp/product-feed.json` |
| `http(s)` URL | `http://127.0.0.1:18765/product-feed.json` |
| Unset or empty | The production feed |

- With an override, the backend re-reads the feed every **5 seconds** instead of every hour.
  Edit the file, wait a few seconds, then reload the page.
- An invalid value (missing file, unsupported scheme) stops the dashboard at startup with an
  error naming the variable. It never falls back to the production feed silently.
- This is for development only. The feed is fetched by the dashboard backend, so the browser
  only ever talks to the dashboard.

## The `promotion` object

```json
"promotion": {
  "id": "advent-of-workflow-local-test",
  "title": "Advent of Workflow is live",
  "text": "12 Dapr Workflow challenges, 1–23 December",
  "url": "https://www.diagrid.io/advent-of-workflow",
  "cta": "Join now",
  "startsAt": "2026-12-01T00:00:00Z",
  "endsAt": "2027-01-03T22:59:59Z"
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Closing the banner hides it for this `id`. A new `id` shows it again. |
| `title` | yes | One short line (about 40 characters fits). |
| `url` | yes | `http` or `https`. The dashboard adds `utm_source=dev-dashboard&utm_medium=banner`. |
| `text` | no | One supporting line. |
| `cta` | no | Link text. Defaults to "Learn more". |
| `startsAt` / `endsAt` | no | RFC 3339 timestamp, or `YYYY-MM-DD`. A date-only `endsAt` lasts through that day (UTC). |

`"promotion": null` or no `promotion` field means no banner. A promotion with a missing required
field, a non-http(s) URL or an unparseable date is dropped. A wrongly typed value (for example
`"promotion": "oops"`) is also dropped, and the rest of the feed still works.

## What to check

| Scenario | How | Expected |
|---|---|---|
| Slide-in | Load any page | Banner appears bottom-right after ~1 s |
| Close stays closed | Click ✕, reload | Banner stays hidden |
| Link closes it | Click **Join now ↗** | Opens in a new tab; banner hidden afterwards |
| New promotion | Change `id`, wait 5 s, reload | Banner shows again |
| Keyboard | Tab into the banner, press Escape | Banner closes; focus moves to the page content |
| Not before it starts | Set `startsAt` in the future, reload | No banner |
| Ends on time | Set `endsAt` one minute ahead, keep the tab open | Banner disappears at `endsAt` without a reload |
| Date-only end | Set `endsAt` to today's date (UTC), reload | Banner shows (lasts through today) |
| Bad data | Set `"promotion": "oops"`, reload | No banner; Resources menu still shows the blog post |
| Unsafe URL | Set `url` to `javascript:alert(1)`, reload | No banner |
| CLI drawer | Open the **CLI** tab on the right | Banner moves to the left of the drawer |
| Replay | Go to `/replay` (or use the Konami code) | No banner |
| Themes and sizes | Toggle **Theme**; resize to 768 px wide | Readable in light and dark; fits at 768 px |

## Resetting what the browser remembers

Closed promotions are stored in `localStorage` (`devdash.promoDismissed`), and "already shown in
this tab" is in `sessionStorage` (`devdash.promoShown`, used for analytics). Both are per
browser origin, so a different `--port` starts clean. To reset the current one, run this in the
DevTools console and reload:

```js
localStorage.removeItem('devdash.promoDismissed'); sessionStorage.removeItem('devdash.promoShown')
```

## Automated tests

```sh
go test -tags unit ./pkg/news ./pkg/server ./cmd -run 'Promotion|NewsFeed|News'
cd web && npx vitest run src/components/PromoBanner src/lib/promoDismissed src/App.test.tsx
```

`TestPromotionFixtureFeed` (in `cmd/newsfeed_test.go`) keeps
`test/fixtures/promotion/product-feed.json` a valid feed with a promotion.
