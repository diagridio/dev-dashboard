# Share the Dashboard — Design

**Date:** 2026-07-15
**Status:** Approved, ready for implementation plan

## Goal

Make it easy for dashboard users to share the Diagrid Dev Dashboard with colleagues
and friends. A share action produces a pre-written message — a short intro, the GitHub
repo link, and direct install one-liners for macOS/Linux and Windows — and lets the user
send it through the channel they prefer (clipboard, email, or social).

## Non-goals

- **No message editing / personalization** in v1 (no "Hi <name>" field). The message is
  fixed; easy to add later.
- No backend involvement — this is entirely a frontend feature. No new API endpoints.
- No share analytics beyond the existing `trackAction` telemetry hook.

## User experience

### Entry point

A **Share icon button** in the top nav's `.topright` container (in `TopNav.tsx`), placed
alongside the existing `RefreshControl` and `ThemeToggle`. Icon-only, with
`aria-label="Share the dashboard"` and a tooltip. Clicking it opens the Share modal and
fires `trackAction('share_open')`.

### Share modal

Built on the existing `Modal` component (`web/src/components/Modal.tsx`), narrow variant.

- **Title:** "Share the dashboard"
- **Intro line:** "Enjoying the dashboard? Send it to a colleague."
- **Message preview:** the full message (see below) shown read-only in a `<pre>` or
  read-only `<textarea>` so users see exactly what Copy/Email will send.
- **Channel button row:** Copy · Email · X · LinkedIn · BlueSky. Each fires
  `trackAction('share_click', { channel })`.
  - **Copy** uses the existing `copyText` helper (`web/src/lib/clipboard.ts`) +
    `toast.show('Copied')`.
  - The other channels open a prefilled URL in a new tab via
    `window.open(url, '_blank', 'noopener')`.

## Message content

### Full message (Copy + Email)

```
Hi!

I'm using the Diagrid Dev Dashboard, a practical companion for local Dapr development. It gives you a live view of everything Dapr running locally — apps, workflows, actors, components, logs, plus guided builders for Dapr component files and resiliency policies. It's free & open source.

GitHub: https://github.com/diagridio/dev-dashboard

Install (macOS / Linux):
curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh

Install (Windows, PowerShell):
iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex

Give it a try!
```

### Short message (social)

Install commands do not render as code on X / LinkedIn / BlueSky and blow past character
limits, so social channels use a short blurb that links to the repo (where install
instructions already live).

**BlueSky variant** (~290 chars, fits the 300 limit; repo URL appended by the builder):

```
I'm using the Diagrid Dev Dashboard — a practical companion for local Dapr development. A live view of everything Dapr running locally (apps, workflows, actors, components, logs) plus guided builders for component files & resiliency policies. Free & open source 👇
```

**X variant** — same as above but with the parenthetical `(apps, workflows, actors,
components, logs)` dropped, so the text plus the appended URL fits X's limit.

## Channel URL builders

All content and URL construction lives in one pure, unit-tested module:
`web/src/lib/share.ts`.

Constants:
- `REPO_URL = "https://github.com/diagridio/dev-dashboard"`
- The two install one-liners, kept verbatim in sync with the README (`main`-branch raw
  URLs).

Builders (all values URL-encoded):

| Channel  | URL |
|----------|-----|
| Email    | `mailto:?subject=<subject, encoded>&body=<full message, encoded>` |
| X        | `https://x.com/intent/tweet?text=<X short message, encoded>&url=<REPO_URL>` |
| BlueSky  | `https://bsky.app/intent/compose?text=<BlueSky short message + REPO_URL, encoded>` |
| LinkedIn | `https://www.linkedin.com/sharing/share-offsite/?url=<REPO_URL>` (LinkedIn ignores prefilled text — URL only) |

Email subject: "Check out the Diagrid Dev Dashboard for local Dapr development".

## Components / files

| File | Responsibility |
|------|----------------|
| `web/src/lib/share.ts` (new) | Message constants + variants + channel URL builder functions. Pure, no React. |
| `web/src/lib/share.test.ts` (new) | Unit tests: message content, encoding, each builder's URL shape. |
| `web/src/components/ShareDialog.tsx` (new) | The modal: preview + channel buttons + telemetry. |
| `web/src/components/ShareDialog.test.tsx` (new) | Renders, copy path, each button opens/encodes correctly (mock `window.open` / clipboard). |
| `web/src/components/TopNav.tsx` (edit) | Add Share icon button + dialog open state. |
| `web/src/components/TopNav.test.tsx` (edit) | Assert button present + opens dialog. |
| `web/src/styles/theme.css` (edit, if needed) | Any styling for the share button / channel row. |

## Data flow

1. User clicks the Share button in `TopNav` → local `open` state true → `trackAction('share_open')`.
2. `ShareDialog` renders the full-message preview from `lib/share.ts`.
3. User clicks a channel button:
   - **Copy** → `copyText(fullMessage)` → `toast.show('Copied')`.
   - **Email / X / LinkedIn / BlueSky** → `window.open(builder(), '_blank', 'noopener')`.
   - Every click → `trackAction('share_click', { channel })`.
4. User closes modal (backdrop, Esc, or close) — handled by `Modal`/`useModalFocus`.

## Error handling / edge cases

- **Clipboard unavailable** — `copyText` already handles the fallback path; reuse it, no
  new handling.
- **Popup blocked** — `window.open` may return null; acceptable (user can still Copy). No
  special UI in v1.
- **Message drift** — install commands are duplicated between README and `share.ts`. A
  code comment in `share.ts` notes the README as the source of truth; a follow-up test
  could assert parity, but that's out of scope for v1.

## Testing

- `lib/share.ts` — pure unit tests for message content and each URL builder (correct host,
  correct params, proper encoding of spaces/newlines/emoji).
- `ShareDialog.tsx` — component tests: preview renders the full message; Copy calls the
  clipboard helper + toast; each channel button invokes `window.open` with the expected
  URL and fires the telemetry event.
- `TopNav.tsx` — button renders and toggles the dialog.
- Run `make build` (tsc typecheck) after any `.ts(x)` change — vitest alone does not
  typecheck.
