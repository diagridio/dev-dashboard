# Share the Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Share the dashboard" feature — a top-nav button that opens a modal offering a pre-written message (intro + GitHub link + install one-liners) sendable via Copy, Email, X, LinkedIn, or BlueSky.

**Architecture:** Pure content + URL-builder module (`lib/share.ts`) that reads all copy from an editable YAML file (`content/share.yaml`, parsed at build time with the already-present `js-yaml`). A `ShareDialog` React component built on the existing `Modal` renders a read-only message preview and a row of channel buttons. `TopNav` gets a Share icon button that toggles the dialog. Frontend-only; no backend changes.

**Tech Stack:** React 19 + TypeScript, Vite 8, Vitest 4, Testing Library, js-yaml (existing dependency), existing helpers `Modal`, `lib/clipboard.copyText`, `lib/toast.useToast`, `lib/telemetry.trackAction`.

## Global Constraints

- Repo URL is exactly `https://github.com/diagridio/dev-dashboard`.
- Install one-liners must match the README verbatim (README is source of truth):
  - macOS/Linux: `curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh`
  - Windows: `iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex`
- All message copy lives in `web/src/content/share.yaml` — no message strings hardcoded in `.ts`/`.tsx`.
- Every channel interaction fires `trackAction('share_click', { channel })`; opening the dialog fires `trackAction('share_open')`.
- Run `npm run build` (from `web/`) after any `.ts`/`.tsx` change — vitest alone does not typecheck.
- All commands below run from the `web/` directory unless stated otherwise.

## File Structure

| File | Responsibility |
|------|----------------|
| `web/src/content/share.yaml` (new) | Editable copy: `emailSubject`, `fullMessage`, `shortX`, `shortBluesky`. Source of truth for wording. |
| `web/src/lib/share.ts` (new) | Parses `share.yaml`, exposes `REPO_URL`, `shareContent`, `ShareChannel`, and per-channel URL builders. Pure, no React. |
| `web/src/lib/share.test.ts` (new) | Unit tests: YAML keys present + non-empty, install commands present, each builder's URL shape + encoding. |
| `web/src/components/ShareDialog.tsx` (new) | The modal: intro + read-only preview + channel button row + telemetry + toast. |
| `web/src/components/ShareDialog.test.tsx` (new) | Component tests: preview renders full message, Copy path, channel anchor hrefs + telemetry. |
| `web/src/components/TopNav.tsx` (modify) | Add Share button in `.topright` + dialog open state. |
| `web/src/components/TopNav.test.tsx` (modify) | Assert Share button present and opens the dialog. |
| `web/src/styles/theme.css` (modify) | `.share-intro`, `.share-preview`, `.share-actions` styles. |

---

### Task 1: Content file + share library

**Files:**
- Create: `web/src/content/share.yaml`
- Create: `web/src/lib/share.ts`
- Test: `web/src/lib/share.test.ts`

**Interfaces:**
- Consumes: `js-yaml` (`load`), Vite `?raw` import (typed via `vite/client`, already in `tsconfig.json` `types`).
- Produces (relied on by Task 2):
  - `REPO_URL: string`
  - `shareContent: { emailSubject: string; fullMessage: string; shortX: string; shortBluesky: string }`
  - `type ShareChannel = 'copy' | 'email' | 'x' | 'linkedin' | 'bluesky'`
  - `emailUrl(): string`, `xUrl(): string`, `linkedinUrl(): string`, `blueskyUrl(): string`

- [ ] **Step 1: Create the content file**

Create `web/src/content/share.yaml`:

```yaml
# Copy shown by the Share dialog. Edit wording here — no code changes needed.
# NOTE: keep the install commands in sync with the README (the source of truth).

emailSubject: "Check out the Diagrid Dev Dashboard for local Dapr development"

# Full message — used by Copy and Email. Install commands included.
fullMessage: |
  Hi!

  I'm using the Diagrid Dev Dashboard, a practical companion for local Dapr development. It gives you a live view of everything Dapr running locally — apps, workflows, actors, components, logs, plus guided builders for Dapr component files and resiliency policies. It's free & open source.

  GitHub: https://github.com/diagridio/dev-dashboard

  Install (macOS / Linux):
  curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh

  Install (Windows, PowerShell):
  iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex

  Give it a try!

# Short blurb for X — repo URL is appended by the builder via ?url=.
shortX: "I'm using the Diagrid Dev Dashboard — a practical companion for local Dapr development. A live view of everything Dapr running locally plus guided builders for component files & resiliency policies. Free & open source 👇"

# Short blurb for BlueSky — repo URL is appended to the text by the builder.
shortBluesky: "I'm using the Diagrid Dev Dashboard — a practical companion for local Dapr development. A live view of everything Dapr running locally (apps, workflows, actors, components, logs) plus guided builders for component files & resiliency policies. Free & open source 👇"
```

- [ ] **Step 2: Write the failing test**

Create `web/src/lib/share.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  REPO_URL,
  shareContent,
  emailUrl,
  xUrl,
  linkedinUrl,
  blueskyUrl,
} from './share'

describe('shareContent', () => {
  it('has all required non-empty keys', () => {
    for (const key of ['emailSubject', 'fullMessage', 'shortX', 'shortBluesky'] as const) {
      expect(typeof shareContent[key]).toBe('string')
      expect(shareContent[key].trim().length).toBeGreaterThan(0)
    }
  })

  it('full message contains the repo URL and both install commands', () => {
    expect(shareContent.fullMessage).toContain(REPO_URL)
    expect(shareContent.fullMessage).toContain('scripts/install.sh | sh')
    expect(shareContent.fullMessage).toContain('scripts/install.ps1 | iex')
  })
})

describe('channel URL builders', () => {
  it('emailUrl encodes subject and full-message body', () => {
    const url = emailUrl()
    expect(url.startsWith('mailto:?')).toBe(true)
    expect(url).toContain(`subject=${encodeURIComponent(shareContent.emailSubject)}`)
    expect(url).toContain(`body=${encodeURIComponent(shareContent.fullMessage)}`)
  })

  it('xUrl points at the intent endpoint with short text and repo url', () => {
    const url = xUrl()
    expect(url.startsWith('https://x.com/intent/tweet?')).toBe(true)
    expect(url).toContain(`text=${encodeURIComponent(shareContent.shortX)}`)
    expect(url).toContain(`url=${encodeURIComponent(REPO_URL)}`)
  })

  it('blueskyUrl includes short text and the repo url in the text', () => {
    const url = blueskyUrl()
    expect(url.startsWith('https://bsky.app/intent/compose?')).toBe(true)
    expect(url).toContain(encodeURIComponent(shareContent.shortBluesky))
    expect(url).toContain(encodeURIComponent(REPO_URL))
  })

  it('linkedinUrl shares the repo url only', () => {
    const url = linkedinUrl()
    expect(url.startsWith('https://www.linkedin.com/sharing/share-offsite/?')).toBe(true)
    expect(url).toContain(`url=${encodeURIComponent(REPO_URL)}`)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/share.test.ts`
Expected: FAIL — cannot resolve `./share` (module not created yet).

- [ ] **Step 4: Write the implementation**

Create `web/src/lib/share.ts`:

```ts
import { load } from 'js-yaml'
import shareYamlRaw from '../content/share.yaml?raw'

export const REPO_URL = 'https://github.com/diagridio/dev-dashboard'

export interface ShareContent {
  emailSubject: string
  fullMessage: string
  shortX: string
  shortBluesky: string
}

/** Parsed at module load from the editable YAML content file. */
export const shareContent = load(shareYamlRaw) as ShareContent

export type ShareChannel = 'copy' | 'email' | 'x' | 'linkedin' | 'bluesky'

/** mailto: with prefilled subject + full message body. */
export function emailUrl(): string {
  const subject = encodeURIComponent(shareContent.emailSubject)
  const body = encodeURIComponent(shareContent.fullMessage)
  return `mailto:?subject=${subject}&body=${body}`
}

/** X intent — short text plus repo URL as a separate param. */
export function xUrl(): string {
  const text = encodeURIComponent(shareContent.shortX)
  const url = encodeURIComponent(REPO_URL)
  return `https://x.com/intent/tweet?text=${text}&url=${url}`
}

/** BlueSky compose intent — repo URL appended to the text (no url param). */
export function blueskyUrl(): string {
  const text = encodeURIComponent(`${shareContent.shortBluesky}\n${REPO_URL}`)
  return `https://bsky.app/intent/compose?text=${text}`
}

/** LinkedIn share — URL only; LinkedIn ignores prefilled text. */
export function linkedinUrl(): string {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(REPO_URL)}`
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/share.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: builds with no TypeScript errors. (Confirms the `?raw` import and `js-yaml` typing resolve.)

- [ ] **Step 7: Commit**

```bash
git add web/src/content/share.yaml web/src/lib/share.ts web/src/lib/share.test.ts
git commit -m "feat: add share content file and URL-builder library"
```

---

### Task 2: ShareDialog component

**Files:**
- Create: `web/src/components/ShareDialog.tsx`
- Modify: `web/src/styles/theme.css` (append the three style rules shown in Step 5)
- Test: `web/src/components/ShareDialog.test.tsx`

**Interfaces:**
- Consumes (from Task 1): `shareContent`, `emailUrl`, `xUrl`, `linkedinUrl`, `blueskyUrl`, `type ShareChannel`.
- Consumes (existing): `Modal` (`{ open, title, onClose, initialFocusRef, narrow, children }`), `copyText(t: string): void` from `../lib/clipboard`, `useToast()` → `{ toast, toastNode }` from `../lib/toast`, `trackAction(name, ctx?)` from `../lib/telemetry`.
- Produces (relied on by Task 3): `ShareDialog` component with props `{ open: boolean; onClose: () => void }`.

Design note: channel targets are rendered as `<a>` anchors (`href` = builder output) rather than `window.open` calls — simpler, no popup-blocker issues, and directly assertable in tests. Email is a plain anchor (opens the mail client); social anchors use `target="_blank" rel="noopener noreferrer"`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/ShareDialog.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ShareDialog } from './ShareDialog'
import { copyText } from '../lib/clipboard'
import { trackAction } from '../lib/telemetry'
import { shareContent, emailUrl, xUrl, linkedinUrl, blueskyUrl } from '../lib/share'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('../lib/telemetry', () => ({ trackAction: vi.fn() }))

const noop = () => {}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ShareDialog', () => {
  it('renders nothing when closed', () => {
    render(<ShareDialog open={false} onClose={noop} />)
    expect(screen.queryByText('Share the dashboard')).toBeNull()
  })

  it('shows the full message preview when open', () => {
    render(<ShareDialog open onClose={noop} />)
    const preview = screen.getByLabelText('Share message preview') as HTMLTextAreaElement
    expect(preview.value).toBe(shareContent.fullMessage)
  })

  it('Copy button copies the full message, shows a toast, and tracks the click', () => {
    render(<ShareDialog open onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(copyText).toHaveBeenCalledWith(shareContent.fullMessage)
    expect(trackAction).toHaveBeenCalledWith('share_click', { channel: 'copy' })
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })

  it('renders channel anchors with the correct hrefs', () => {
    render(<ShareDialog open onClose={noop} />)
    expect(screen.getByRole('link', { name: 'Email' })).toHaveAttribute('href', emailUrl())
    expect(screen.getByRole('link', { name: 'X' })).toHaveAttribute('href', xUrl())
    expect(screen.getByRole('link', { name: 'LinkedIn' })).toHaveAttribute('href', linkedinUrl())
    expect(screen.getByRole('link', { name: 'BlueSky' })).toHaveAttribute('href', blueskyUrl())
  })

  it('tracks the channel when a social anchor is clicked', () => {
    render(<ShareDialog open onClose={noop} />)
    fireEvent.click(screen.getByRole('link', { name: 'X' }))
    expect(trackAction).toHaveBeenCalledWith('share_click', { channel: 'x' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/ShareDialog.test.tsx`
Expected: FAIL — cannot resolve `./ShareDialog`.

- [ ] **Step 3: Write the component**

Create `web/src/components/ShareDialog.tsx`:

```tsx
import { useRef } from 'react'
import { Modal } from './Modal'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import { trackAction } from '../lib/telemetry'
import {
  shareContent,
  emailUrl,
  xUrl,
  linkedinUrl,
  blueskyUrl,
  type ShareChannel,
} from '../lib/share'

interface Props {
  open: boolean
  onClose: () => void
}

export function ShareDialog({ open, onClose }: Props) {
  const { toast, toastNode } = useToast()
  const copyRef = useRef<HTMLButtonElement>(null)

  function track(channel: ShareChannel) {
    trackAction('share_click', { channel })
  }

  function handleCopy() {
    copyText(shareContent.fullMessage)
    toast.show('Copied')
    track('copy')
  }

  return (
    <Modal
      open={open}
      title="Share the dashboard"
      onClose={onClose}
      initialFocusRef={copyRef}
      narrow
    >
      <p className="share-intro">Enjoying the dashboard? Send it to a colleague.</p>
      <textarea
        className="share-preview"
        aria-label="Share message preview"
        readOnly
        rows={12}
        value={shareContent.fullMessage}
      />
      <div className="modal-actions share-actions">
        <button ref={copyRef} type="button" className="btn primary" onClick={handleCopy}>
          Copy
        </button>
        <a className="btn ghost" href={emailUrl()} onClick={() => track('email')}>
          Email
        </a>
        <a
          className="btn ghost"
          href={xUrl()}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track('x')}
        >
          X
        </a>
        <a
          className="btn ghost"
          href={linkedinUrl()}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track('linkedin')}
        >
          LinkedIn
        </a>
        <a
          className="btn ghost"
          href={blueskyUrl()}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track('bluesky')}
        >
          BlueSky
        </a>
      </div>
      {toastNode}
    </Modal>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/ShareDialog.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Add styles**

Append to `web/src/styles/theme.css`:

```css
.share-intro { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
.share-preview { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; line-height: 1.5; color: var(--text); background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; resize: vertical; }
.share-actions { flex-wrap: wrap; justify-content: flex-start; }
```

- [ ] **Step 6: Typecheck**

Run: `npm run build`
Expected: builds with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/ShareDialog.tsx web/src/components/ShareDialog.test.tsx web/src/styles/theme.css
git commit -m "feat: add ShareDialog modal with channel buttons"
```

---

### Task 3: Wire the Share button into TopNav

**Files:**
- Modify: `web/src/components/TopNav.tsx`
- Test: `web/src/components/TopNav.test.tsx`

**Interfaces:**
- Consumes (from Task 2): `ShareDialog` with props `{ open, onClose }`.
- Consumes (existing): `trackAction` from `../lib/telemetry`.
- Produces: a Share button (`className="tbtn"`, `aria-label="Share the dashboard"`) in `.topright` that toggles the dialog and fires `trackAction('share_open')` on open.

- [ ] **Step 1: Write the failing test**

The file already imports `render, screen, fireEvent` and `trackAction`, mocks `../lib/telemetry` with `vi.mock('../lib/telemetry', () => ({ trackAction: vi.fn() }))`, and defines a `renderNav()` helper inside `describe('TopNav', ...)`. **Reuse that existing helper — do not redefine it.**

Add these two `it()` cases inside the existing `describe('TopNav', ...)` block, immediately after the `it('renders the compact refresh control', ...)` test (around line 87):

```tsx
  it('renders a Share button', () => {
    renderNav()
    expect(
      screen.getByRole('button', { name: 'Share the dashboard' }),
    ).toBeInTheDocument()
  })

  it('opens the Share dialog and tracks share_open', () => {
    renderNav()
    expect(
      screen.queryByText('Enjoying the dashboard? Send it to a colleague.'),
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Share the dashboard' }))
    expect(
      screen.getByText('Enjoying the dashboard? Send it to a colleague.'),
    ).toBeInTheDocument()
    expect(trackAction).toHaveBeenCalledWith('share_open')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/TopNav.test.tsx`
Expected: FAIL — no button named "Share the dashboard".

- [ ] **Step 3: Add imports and state to TopNav**

In `web/src/components/TopNav.tsx`, update the React import (line 1) from:

```tsx
import { useEffect, useRef } from 'react'
```
to:
```tsx
import { useEffect, useRef, useState } from 'react'
```

Add this import alongside the other component imports (after the `RefreshControl` import):

```tsx
import { ShareDialog } from './ShareDialog'
```

Inside the `TopNav` function body, after `const items = NAV_ITEMS.filter(...)`, add:

```tsx
  const [shareOpen, setShareOpen] = useState(false)

  function openShare() {
    setShareOpen(true)
    trackAction('share_open')
  }
```

- [ ] **Step 4: Render the button and dialog**

In `web/src/components/TopNav.tsx`, replace the `.topright` block:

```tsx
      <div className="topright">
        <RefreshControl />
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
      </div>
```

with:

```tsx
      <div className="topright">
        <button
          type="button"
          className="tbtn"
          aria-label="Share the dashboard"
          onClick={openShare}
        >
          ↗ Share
        </button>
        <RefreshControl />
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
      </div>

      <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} />
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/TopNav.test.tsx`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 6: Run the full web test suite + typecheck**

Run: `npm test`
Expected: all suites pass.

Run: `npm run build`
Expected: builds with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/TopNav.tsx web/src/components/TopNav.test.tsx
git commit -m "feat: add Share button to top nav"
```

---

## Manual verification

After Task 3, verify the feature end-to-end in the running app:

- [ ] From repo root, run `make build` then start the binary (`./bin/diagrid-dev-dashboard`) and open the dashboard.
- [ ] Click **Share** in the top nav — the modal opens showing the full message preview.
- [ ] Click **Copy** — paste into a text editor and confirm the message matches `share.yaml`, including both install commands and the repo URL.
- [ ] Click **Email** — the mail client opens with the subject and full body prefilled.
- [ ] Click **X**, **LinkedIn**, **BlueSky** — each opens the respective composer/share page in a new tab with the expected prefilled text / URL.
