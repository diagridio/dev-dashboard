# Resources / News / Actors / Workflow UI Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply five focused UI/backend updates — footer rebrand, news-link UTM tagging, Actors link color, and two Workflow-detail Input/Output improvements.

**Architecture:** Four frontend changes in `web/src` (React + CSS) and one Go backend change in `pkg/news`. Each task is independent and self-contained. Only the Go change has automated unit tests (existing `news_test.go`); the frontend changes are verified by the TypeScript build (`tsc -b`) plus the existing vitest suite and manual visual checks.

**Tech Stack:** React + TypeScript (Vite, vitest), plain CSS (`theme.css`), Go (standard library `net/url`).

## Global Constraints

- UTM parameters for **news menu** links: `utm_source=dev-dashboard` and `utm_medium=menu`. Applied server-side, only to `diagrid.io` / `www.diagrid.io` hosts, preserving existing query params.
- UTM parameters for the **footer** Diagrid link: `utm_source=dev-dashboard` and `utm_medium=footer`.
- Footer text keeps the version number: `Powered by [Diagrid] · v{version}`.
- The 15-line height cap + scroll applies to BOTH the top Input/Output panels and the Event History Input/Output fields.
- External links open in a new tab with `target="_blank" rel="noopener noreferrer"`.
- In-table entity links use the existing `.celllink` class (never browser-default purple/blue).
- Do not refactor unrelated code. Follow existing patterns.

---

### Task 1: Footer "Powered by Diagrid"

**Files:**
- Modify: `web/src/components/ResourcesSidebar.tsx:253-255`
- Modify: `web/src/styles/theme.css` (add `.pw a` rules near the existing `.sbfoot` / `.pw` styles)

**Interfaces:**
- Consumes: existing `version` variable already in scope in the component (rendered as `v{version}`).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Update the footer markup**

In `web/src/components/ResourcesSidebar.tsx`, replace:

```tsx
      <div className="sbfoot">
        <span className="pw">Dapr Dev Dashboard · v{version}</span>
      </div>
```

with:

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

- [ ] **Step 2: Add the footer link style**

In `web/src/styles/theme.css`, find the `.pw` rule (the footer label class). Immediately after it, add:

```css
.pw a { color: inherit; text-decoration: none; }
.pw a:hover { text-decoration: underline; }
```

If a `.pw` rule cannot be found, add these two lines adjacent to the `.sbfoot` rule instead.

- [ ] **Step 3: Verify the build passes**

Run: `cd web && npm run build`
Expected: build completes with no TypeScript errors.

- [ ] **Step 4: Manual visual check**

Run: `cd web && npm run dev`, open the app, expand the Resources sidebar.
Expected: footer reads "Powered by Diagrid · v<version>"; "Diagrid" is a link in the footer text color (not purple/blue) and underlines on hover; clicking opens `https://diagrid.io/?utm_source=dev-dashboard&utm_medium=footer` in a new tab.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ResourcesSidebar.tsx web/src/styles/theme.css
git commit -m "feat(web): rebrand resources footer to 'Powered by Diagrid'"
```

---

### Task 2: UTM parameters on news links (Go backend)

**Files:**
- Modify: `pkg/news/news.go` (add `withUTM` helper; call it inside `derive()` ~lines 117-150; add imports `net/url` and `strings`)
- Test: `pkg/news/news_test.go` (add `TestWithUTM`)

**Interfaces:**
- Consumes: the `feedPayload` and `Response`/`Item` types already in `news.go`.
- Produces: `func withUTM(raw string) string` — package-private helper; appends `utm_source=dev-dashboard&utm_medium=menu` to `diagrid.io`/`www.diagrid.io` URLs, returns others unchanged.

- [ ] **Step 1: Write the failing test**

Add to `pkg/news/news_test.go`:

```go
func TestWithUTM(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "diagrid host gets utm params",
			in:   "https://www.diagrid.io/blog/some-post",
			want: "https://www.diagrid.io/blog/some-post?utm_medium=menu&utm_source=dev-dashboard",
		},
		{
			name: "bare diagrid host gets utm params",
			in:   "https://diagrid.io/events/webinar",
			want: "https://diagrid.io/events/webinar?utm_medium=menu&utm_source=dev-dashboard",
		},
		{
			name: "non-diagrid host unchanged",
			in:   "https://example.com/article",
			want: "https://example.com/article",
		},
		{
			name: "existing query param preserved",
			in:   "https://www.diagrid.io/blog/post?ref=newsletter",
			want: "https://www.diagrid.io/blog/post?ref=newsletter&utm_medium=menu&utm_source=dev-dashboard",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := withUTM(tc.in)
			if got != tc.want {
				t.Fatalf("withUTM(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
```

Note: Go's `url.Values.Encode()` sorts keys alphabetically, so the expected order is `ref` (if present), then `utm_medium`, then `utm_source`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/news/ -run TestWithUTM -v`
Expected: FAIL — `undefined: withUTM` (compile error).

- [ ] **Step 3: Add imports**

In `pkg/news/news.go`, update the import block to include `net/url` and `strings`:

```go
import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)
```

- [ ] **Step 4: Implement `withUTM`**

In `pkg/news/news.go`, add this helper directly above the `derive` function:

```go
// withUTM appends dev-dashboard UTM parameters to URLs on the diagrid.io
// domain, preserving any existing query parameters. URLs on other hosts (or
// that fail to parse) are returned unchanged.
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

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test ./pkg/news/ -run TestWithUTM -v`
Expected: PASS (all four sub-cases).

- [ ] **Step 6: Apply `withUTM` in `derive()`**

In `pkg/news/news.go`, inside `derive()`, set each selected item's URL before assigning it. Replace the four assignment blocks so they read:

```go
	if len(p.LatestBlogPosts) > 0 {
		item := p.LatestBlogPosts[0]
		item.URL = withUTM(item.URL)
		r.Blog = &item
	}
	if len(p.LatestReports) > 0 {
		item := p.LatestReports[0]
		item.URL = withUTM(item.URL)
		r.Report = &item
	}
```

and in each of the two upcoming loops (webinar, event), add the URL rewrite right before assigning the pointer:

```go
	for i := range p.UpcomingWebinars {
		t, err := time.Parse(time.RFC3339, p.UpcomingWebinars[i].EventStartDate)
		if err != nil {
			continue // parse error → skip
		}
		if t.After(now) {
			item := p.UpcomingWebinars[i]
			item.URL = withUTM(item.URL)
			r.Webinar = &item
			break
		}
	}

	for i := range p.UpcomingEvents {
		t, err := time.Parse(time.RFC3339, p.UpcomingEvents[i].EventStartDate)
		if err != nil {
			continue // parse error → skip
		}
		if t.After(now) {
			item := p.UpcomingEvents[i]
			item.URL = withUTM(item.URL)
			r.Event = &item
			break
		}
	}
```

- [ ] **Step 7: Run the full news package tests**

Run: `go test ./pkg/news/ -v`
Expected: PASS — `TestWithUTM`, `TestNewsSlotsAndCache`, `TestNewsLastGoodOnFailure` all pass.

- [ ] **Step 8: Commit**

```bash
git add pkg/news/news.go pkg/news/news_test.go
git commit -m "feat(news): append UTM params to diagrid.io feed links"
```

---

### Task 3: Actors page App ID link color

**Files:**
- Modify: `web/src/pages/Actors.tsx:128-130`

**Interfaces:**
- Consumes: existing `.celllink` CSS class in `theme.css` (already defined: `color: var(--text); text-decoration: none;`).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the `celllink` class**

In `web/src/pages/Actors.tsx`, replace:

```tsx
      <td className="b">
        <Link to={`/apps/${actor.appId}`}>{actor.appId}</Link>
      </td>
```

with:

```tsx
      <td className="b">
        <Link className="celllink" to={`/apps/${actor.appId}`}>{actor.appId}</Link>
      </td>
```

Do NOT add `onClick={(e) => e.stopPropagation()}` unless the Actors table row is itself a clickable navigation target. Check the surrounding `ActorRow`: if the `<tr>` (or its container) has an `onClick` that navigates, add `onClick={(e) => e.stopPropagation()}` to the `<Link>` to match the Applications page; otherwise leave it off.

- [ ] **Step 2: Verify the build passes**

Run: `cd web && npm run build`
Expected: build completes with no TypeScript errors.

- [ ] **Step 3: Manual visual check**

Open the Actors page. Expected: App ID links render in the normal text color (black in light mode), matching the Applications page, and underline on hover instead of showing browser purple.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Actors.tsx
git commit -m "fix(web): use celllink color for Actors App ID links"
```

---

### Task 4: Cap Input/Output fields at 15 lines with scroll

**Files:**
- Modify: `web/src/styles/theme.css:332` (`pre.json`)
- Modify: `web/src/styles/theme.css:368` (`.evbody pre`)

**Interfaces:**
- Consumes: existing `pre.json` and `.evbody pre` rules.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Cap the top Input/Output panels**

In `web/src/styles/theme.css`, replace the `pre.json` rule (line 332):

```css
pre.json { margin: 0; padding: 13px; font-family: var(--mono); font-size: 12px; line-height: 1.6; overflow-x: auto; white-space: pre; }
```

with (line-height 1.6 × 15 lines = 24em; `overflow: auto` enables both axes):

```css
pre.json { margin: 0; padding: 13px; font-family: var(--mono); font-size: 12px; line-height: 1.6; max-height: 24em; overflow: auto; white-space: pre; }
```

- [ ] **Step 2: Cap the Event History fields**

In `web/src/styles/theme.css`, replace the `.evbody pre` rule (line 368):

```css
.evbody pre { margin: 0; font-family: var(--mono); font-size: 11.5px; line-height: 1.55; background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 8px; padding: 9px 11px; overflow-x: auto; }
```

with (line-height 1.55 × 15 lines ≈ 23.25em):

```css
.evbody pre { margin: 0; font-family: var(--mono); font-size: 11.5px; line-height: 1.55; background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 8px; padding: 9px 11px; max-height: 23.25em; overflow: auto; }
```

- [ ] **Step 3: Verify the build passes**

Run: `cd web && npm run build`
Expected: build completes with no errors.

- [ ] **Step 4: Manual visual check**

Open a Workflow detail page that has large (100+ line) JSON input/output, and expand an Event History entry with large input/output.
Expected: both the top panels and the event-history fields stop growing at ~15 visible lines and show a vertical scroll bar; long single lines still scroll horizontally.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/theme.css
git commit -m "fix(web): cap workflow Input/Output fields at 15 lines with scroll"
```

---

### Task 5: Copy buttons in Event History Input/Output

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx:10` (import `ToastHandle` type)
- Modify: `web/src/pages/WorkflowDetail.tsx:109-173` (`EventRow` — add `toast` prop, add copy buttons)
- Modify: `web/src/pages/WorkflowDetail.tsx:499-506` (pass `toast` prop into `<EventRow>`)

**Interfaces:**
- Consumes: `copyText` (already imported from `../lib/clipboard`); `toast` of type `ToastHandle` from `../lib/toast` (the parent already has `const { toast, toastNode } = useToast()` at line 191); existing `.evbody .lblrow` and `.evbody .lblrow .copybtn` CSS in `theme.css` (already defined).
- Produces: `EventRow` now requires a `toast: ToastHandle` prop.

- [ ] **Step 1: Import the `ToastHandle` type**

In `web/src/pages/WorkflowDetail.tsx`, change line 10 from:

```tsx
import { useToast } from '../lib/toast'
```

to:

```tsx
import { useToast, type ToastHandle } from '../lib/toast'
```

- [ ] **Step 2: Add the `toast` prop to `EventRow`**

In `web/src/pages/WorkflowDetail.tsx`, update the `EventRow` signature:

```tsx
export function EventRow({
  event,
  createdAt,
  isNewest,
  toast,
}: {
  event: WorkflowHistoryEvent
  createdAt: string | undefined
  isNewest: boolean
  toast: ToastHandle
}) {
```

- [ ] **Step 3: Add copy buttons to the Input/Output fields**

In the same `EventRow`, replace the `.evbody` block:

```tsx
            <div className="evbody">
              {event.input && (
                <div>
                  <div className="lbl">Input</div>
                  <pre className="json">{highlightJson(event.input)}</pre>
                </div>
              )}
              {event.output && (
                <div>
                  <div className="lbl">Output</div>
                  <pre className="json">{highlightJson(event.output)}</pre>
                </div>
              )}
            </div>
```

with:

```tsx
            <div className="evbody">
              {event.input && (
                <div>
                  <div className="lblrow">
                    <span className="lbl">Input</span>
                    <button
                      className="copybtn"
                      onClick={() => {
                        copyText(event.input ?? '')
                        toast.show('Input copied')
                      }}
                    >
                      ⧉ Copy
                    </button>
                  </div>
                  <pre className="json">{highlightJson(event.input)}</pre>
                </div>
              )}
              {event.output && (
                <div>
                  <div className="lblrow">
                    <span className="lbl">Output</span>
                    <button
                      className="copybtn"
                      onClick={() => {
                        copyText(event.output ?? '')
                        toast.show('Output copied')
                      }}
                    >
                      ⧉ Copy
                    </button>
                  </div>
                  <pre className="json">{highlightJson(event.output)}</pre>
                </div>
              )}
            </div>
```

- [ ] **Step 4: Pass `toast` into `<EventRow>`**

In `web/src/pages/WorkflowDetail.tsx`, update the timeline map (lines 499-506) to pass the prop:

```tsx
          {orderedHistory.map((event, idx) => (
            <EventRow
              key={idx}
              event={event}
              createdAt={execution.createdAt}
              isNewest={idx === orderedHistory.length - 1}
              toast={toast}
            />
          ))}
```

- [ ] **Step 5: Verify the build passes**

Run: `cd web && npm run build`
Expected: build completes with no TypeScript errors (in particular, no "missing prop `toast`" error on `EventRow`).

- [ ] **Step 6: Manual visual check**

Open a Workflow detail page, expand an Event History entry that has input and output.
Expected: each of Input and Output shows a "⧉ Copy" button next to its label; clicking copies the field to the clipboard and shows a toast ("Input copied" / "Output copied"), matching the top panels.

- [ ] **Step 7: Run the frontend test suite**

Run: `cd web && npm test`
Expected: existing tests pass (no regressions). If a test renders `EventRow` directly, it will now need a `toast` prop — update such tests to pass a stub `{ show: () => {} }` cast as needed.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx
git commit -m "feat(web): add copy buttons to Event History Input/Output"
```

---

## Self-Review Notes

- **Spec coverage:** Req 1 → Task 1; Req 2 → Task 2; Req 3 → Task 3; Req 4 → Task 4; Req 5 → Task 5. All five covered.
- **Type consistency:** `withUTM(raw string) string` used consistently in Task 2. `ToastHandle` imported (Task 5 Step 1) and used in the `EventRow` prop type (Step 2) and passed from the parent's existing `toast` (Step 4).
- **UTM medium values:** news links = `menu` (Task 2), footer link = `footer` (Task 1) — matches Global Constraints.
- **Encoding order:** Go `url.Values.Encode()` sorts keys; test expectations reflect alphabetical order (`ref`, `utm_medium`, `utm_source`).
