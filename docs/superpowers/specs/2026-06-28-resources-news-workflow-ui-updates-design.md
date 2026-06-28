# Design: Resources panel, news UTM, Actors link, and Workflow detail updates

**Date:** 2026-06-28
**Status:** Approved

## Overview

Five focused UI/backend updates to the dev-dashboard:

1. Replace the Resources panel footer label with "Powered by Diagrid" (Diagrid links to diagrid.io).
2. Append UTM parameters to diagrid.io news links, server-side, after the feed is collected.
3. Change the Actors page App ID link color from browser-default purple to black, matching the Applications page.
4. Cap the Workflow detail Input/Output fields at 15 lines tall with scroll bars (top panels and event-history fields).
5. Add copy buttons to the Input/Output fields inside each Event History entry.

These are independent changes touching the React frontend (`web/src`) and the Go backend (`pkg/news`).

---

## 1. Footer: "Powered by Diagrid"

**File:** `web/src/components/ResourcesSidebar.tsx` (~line 254)

Current:

```tsx
<div className="sbfoot">
  <span className="pw">Dapr Dev Dashboard · v{version}</span>
</div>
```

New: the version number is kept; "Diagrid" becomes a link.

```tsx
<div className="sbfoot">
  <span className="pw">
    Powered by{' '}
    <a
      href="https://diagrid.io/?utm_source=dev-dashboard&utm_medium=footer"
      target="_blank"
      rel="noopener noreferrer"
    >
      Diagrid
    </a>
    {' · '}v{version}
  </span>
</div>
```

**Styling:** Add a rule in `web/src/styles/theme.css` so `.pw a` uses the surrounding muted footer color (not browser purple/blue), with underline on hover. Example:

```css
.pw a { color: inherit; text-decoration: none; }
.pw a:hover { text-decoration: underline; }
```

**Decision:** Version number is retained. Footer link carries `utm_source=dev-dashboard&utm_medium=footer` (distinct from the news menu links).

---

## 2. UTM parameters on news links (server-side)

**File:** `pkg/news/news.go`, `derive()` function (~lines 114-153)

The news service fetches `https://www.diagrid.io/api/product-feed`, then `derive()` selects one item each for Blog, Report, Webinar, Event. UTM params are appended here, after collection, per requirement.

Add a helper:

```go
// withUTM appends dev-dashboard UTM parameters to URLs on the diagrid.io
// domain, preserving any existing query parameters. Non-diagrid URLs are
// returned unchanged.
func withUTM(raw string) string {
    u, err := url.Parse(raw)
    if err != nil {
        return raw
    }
    host := strings.ToLower(u.Hostname())
    if host != "diagrid.io" && host != "www.diagrid.io" {
        return raw
    }
    q := u.Query()
    q.Set("utm_source", "dev-dashboard")
    q.Set("utm_medium", "menu")
    u.RawQuery = q.Encode()
    return u.String()
}
```

Apply it to each selected item's `URL` in `derive()`, e.g.:

```go
if len(p.LatestBlogPosts) > 0 {
    item := p.LatestBlogPosts[0]
    item.URL = withUTM(item.URL)
    r.Blog = &item
}
```

...and the same for Report, Webinar, and Event after each is selected.

**Imports:** add `net/url` and `strings` if not already present.

**Behavior decisions:**
- Only `diagrid.io` and `www.diagrid.io` hosts get UTM params; other hosts pass through unchanged.
- Existing query parameters on the URL are preserved (`q.Set` only overwrites the two UTM keys).
- Frontend is untouched — it renders whatever URL the API returns.

**Tests:** Add a Go unit test for `withUTM` covering:
- A `diagrid.io` URL gains both UTM params.
- A `www.diagrid.io` URL gains both UTM params.
- A non-diagrid URL is returned unchanged.
- A diagrid URL with an existing query param keeps that param and adds the UTM params.

---

## 3. Actors page App ID link color

**File:** `web/src/pages/Actors.tsx` (~lines 128-130)

Current:

```tsx
<td className="b">
  <Link to={`/apps/${actor.appId}`}>{actor.appId}</Link>
</td>
```

New: add `className="celllink"` to match the Applications page, which swaps the browser-default purple for `var(--text)` (black in light mode):

```tsx
<td className="b">
  <Link className="celllink" to={`/apps/${actor.appId}`}>{actor.appId}</Link>
</td>
```

The `.celllink` class already exists in `theme.css`:

```css
.celllink { color: var(--text); text-decoration: none; }
.celllink:hover { text-decoration: underline; }
```

**Note:** The Applications page also has `onClick={(e) => e.stopPropagation()}` because its rows are clickable. During implementation, check whether the Actors row is itself clickable; only add `stopPropagation` if it is, to match existing behavior. (No new behavior beyond the color change is intended.)

---

## 4. Input/Output 15-line cap with scroll

**File:** `web/src/styles/theme.css`

Cap the JSON display fields at ~15 lines tall and add scroll bars when content overflows. Applies to **both** the top Input/Output panels (`pre.json`) and the Event History fields (`.evbody pre`).

- Top panels: `pre.json` has `line-height: 1.6`, `font-size: 12px`.
- Event history: `.evbody pre` has `line-height: 1.55`, `font-size: 11.5px`.

Add `max-height` ≈ 15 lines and switch `overflow-x: auto` to `overflow: auto` so both axes scroll:

```css
pre.json {
  /* ...existing... */
  max-height: calc(15 * 1.6 * 12px); /* ~288px */
  overflow: auto;
}

.evbody pre {
  /* ...existing... */
  max-height: calc(15 * 1.55 * 11.5px); /* ~267px */
  overflow: auto;
}
```

Exact values may be expressed in `em` or `px` during implementation as long as the visible height is ~15 lines. Horizontal scroll behavior is preserved.

**Decision:** The cap applies to both the top panels and the event-history fields (consistent, prevents any field from growing huge).

---

## 5. Copy buttons in Event History Input/Output

**File:** `web/src/pages/WorkflowDetail.tsx`, `EventRow` component (~lines 147-158)

The top panels already have copy buttons using `copyText()` + `toast.show()`. The event-history Input/Output fields currently have only a `.lbl` label and no copy button. CSS for `.evbody .lblrow .copybtn` already exists, so wrap each label in a `.lblrow` flex row with a copy button.

Current:

```tsx
{event.input && (
  <div>
    <div className="lbl">Input</div>
    <pre className="json">{highlightJson(event.input)}</pre>
  </div>
)}
```

New:

```tsx
{event.input && (
  <div>
    <div className="lblrow">
      <span className="lbl">Input</span>
      <button
        className="copybtn"
        onClick={() => { copyText(event.input ?? ''); toast.show('Input copied') }}
      >
        ⧉ Copy
      </button>
    </div>
    <pre className="json">{highlightJson(event.input)}</pre>
  </div>
)}
```

...and the same pattern for Output (`toast.show('Output copied')`).

**Toast access:** `EventRow` is a standalone exported function. The top panels access `toast` via a hook/context in the page component. During implementation, verify how `toast` is obtained inside `EventRow` — either call the same toast hook directly inside `EventRow`, or thread `toast` (and `copyText` is a plain import) through as a prop. Prefer matching whatever pattern the codebase already uses for toasts in sub-components.

---

## Out of scope

- No changes to the news fetch caching, schedule, or the four-slot selection logic.
- No restyling of news links beyond what UTM requires.
- No refactoring unrelated to these five changes.

## Testing summary

- **Go:** unit test for `withUTM` (4 cases above). Run `go test ./...` for the news package.
- **Frontend:** manual/visual verification — footer link, Actors link color, JSON field height + scroll, and event-history copy buttons (verify clipboard + toast). Build with the project's frontend build/lint to confirm no type errors.
