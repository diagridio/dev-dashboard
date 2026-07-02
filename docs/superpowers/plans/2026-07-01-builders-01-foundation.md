# Builders — Plan 1: Shared Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reusable, unit-tested foundation (YAML emitter, validators, download helper, data types, controlled form controls, and a presentational wizard shell) that the Component Builder (Plan 2) and Resiliency Builder (Plan 3) are built on.

**Architecture:** Pure modules and presentational components on dev-dashboard's existing stack — vanilla CSS theme tokens, controlled components, TanStack Query. No routing/nav changes in this plan (those ship with each builder that needs them, in Plans 2–3, to avoid wiring routes to not-yet-existent builder pages). Logic is ported faithfully from cloudgrid but reimplemented without MUI/react-hook-form/Yup.

**Tech Stack:** React 19, TypeScript, Vite, Vitest + Testing Library, `js-yaml` (new dependency).

**Source spec:** `docs/superpowers/specs/2026-06-28-component-resiliency-builders-design.md`

## Global Constraints

- **Stack:** React 19 + TS + Vite; React Router v6; TanStack Query v5; controlled components. Vanilla CSS with semantic tokens in `web/src/styles/theme.css`. Light/dark via `data-theme`.
- **No new UI/validation libraries:** NO MUI, react-hook-form, Yup, Ace, i18n, notistack.
- **Exactly one new dependency approved:** `js-yaml` (emission only, `dump()`). Add `@types/js-yaml` as a dev dependency for types.
- **Wizard buttons monochrome, NOT green:** never use the green brand `.btn.primary` (`background: var(--accent2)`) in wizard/builder UI. Do NOT change the global `.btn.primary` (used elsewhere). Primary action (Continue/Finish) = filled neutral `background: var(--text); color: var(--bg)`; secondary (Back/Cancel) = existing `.btn.ghost`. Copy/Download also neutral/ghost.
- **Tests:** Vitest + Testing Library, colocated `*.test.ts(x)`. Run `npx tsc -b` before every commit (Vitest does not type-check).
- **All `npm`/`npx` commands run from the `web/` subdirectory.**
- **Reuse, don't rebuild:** `lib/api.ts` (`fetchJSON`/`apiUrl`), `lib/clipboard.ts` (`copyText`), `lib/toast.tsx` (`useToast`), `lib/yaml-highlight.tsx` (`highlightYaml`), `components/Modal.tsx`, `components/MetadataFieldInput.tsx`.

---

## File Structure

- Create `web/src/lib/yaml-emit.ts` — `dumpYaml()` + `recursivelyRemoveEmptyValues()`.
- Create `web/src/lib/validation.ts` — `validateGoDuration`, `validateResourceName`, `validateStatusCodes`, `requiredError`, `integerError`.
- Create `web/src/lib/download.ts` — `downloadText(filename, text)`.
- Create `web/src/types/component.ts` — `ComponentSpec`, `defaultComponentSpec()`.
- Create `web/src/types/resiliency.ts` — `DaprResiliency` + policy/target types, `defaultResiliencyConfig()`.
- Modify `web/src/types/metadata.ts` — add `AuthenticationProfile`, `authenticationProfiles?`, `isCert?`, `binding?`.
- Create `web/src/components/form/Field.tsx`, `TextInput.tsx`, `NumberInput.tsx`, `SelectInput.tsx`, `Toggle.tsx`, `index.ts`.
- Create `web/src/components/wizard/Stepper.tsx`, `StepNav.tsx`, `Wizard.tsx`, `index.ts`.
- Modify `web/src/styles/theme.css` — append wizard-scoped styles incl. `.btn.mono` and `.wizard`/`.stepper` layout.

Each task ends with a green focused test, a green `tsc -b`, and a commit.

---

## Task 1: YAML emitter + empty-value stripper

**Files:**
- Create: `web/src/lib/yaml-emit.ts`
- Create: `web/src/lib/yaml-emit.test.ts`
- Modify: `web/package.json` (add `js-yaml`, `@types/js-yaml`)

**Interfaces:**
- Produces: `dumpYaml(obj: unknown): string` and `recursivelyRemoveEmptyValues<T>(input: T): T`.

- [ ] **Step 1: Install js-yaml**

Run (from `web/`):
```bash
npm install js-yaml && npm install -D @types/js-yaml
```
Expected: `js-yaml` in dependencies, `@types/js-yaml` in devDependencies.

- [ ] **Step 2: Write the failing test**

Create `web/src/lib/yaml-emit.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { dumpYaml, recursivelyRemoveEmptyValues } from './yaml-emit'

describe('dumpYaml', () => {
  it('serializes a plain object to YAML', () => {
    expect(dumpYaml({ a: 1, b: 'x' })).toBe('a: 1\nb: x\n')
  })
})

describe('recursivelyRemoveEmptyValues', () => {
  it('removes null, undefined, empty string, whitespace string', () => {
    expect(recursivelyRemoveEmptyValues({ a: null, b: undefined, c: '', d: '  ', e: 'keep' })).toEqual({ e: 'keep' })
  })
  it('preserves 0 and false', () => {
    expect(recursivelyRemoveEmptyValues({ n: 0, b: false })).toEqual({ n: 0, b: false })
  })
  it('removes empty objects and empty arrays', () => {
    expect(recursivelyRemoveEmptyValues({ o: {}, a: [], keep: { x: 1 } })).toEqual({ keep: { x: 1 } })
  })
  it('prunes branches that become empty after recursion', () => {
    expect(recursivelyRemoveEmptyValues({ policies: { retries: { r1: { duration: '' } } } })).toEqual({})
  })
  it('keeps non-empty nested values and does not mutate the input', () => {
    const input = { spec: { timeout: '30s', extra: '' } }
    const out = recursivelyRemoveEmptyValues(input)
    expect(out).toEqual({ spec: { timeout: '30s' } })
    expect(input.spec.extra).toBe('') // original untouched
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- yaml-emit`
Expected: FAIL — cannot resolve `./yaml-emit`.

- [ ] **Step 4: Implement**

Create `web/src/lib/yaml-emit.ts`:
```ts
import { dump } from 'js-yaml'

/** Serialize an object to YAML using js-yaml defaults (matches cloudgrid: no options). */
export function dumpYaml(obj: unknown): string {
  return dump(obj)
}

// lodash-isEmpty equivalent for the only cases used here: plain objects and arrays.
function isEmptyContainer(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0
  if (v && typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  return false
}

/**
 * Deep-clone `input`, then delete keys whose value is null/undefined, an
 * empty/whitespace string, or an empty object/array — recursing into nested
 * objects and pruning branches that become empty. Numbers (incl. 0) and
 * booleans (incl. false) are preserved. Ported from cloudgrid
 * resiliency-builder/utils.ts `recursivelyRemoveEmptyValues`.
 */
export function recursivelyRemoveEmptyValues<T>(input: T): T {
  const obj = structuredClone(input)
  if (typeof obj === 'object' && obj !== null) {
    const rec = obj as Record<string, unknown>
    for (const key of Object.keys(rec)) {
      const v = rec[key]
      if (
        v === null ||
        v === undefined ||
        (typeof v === 'string' && v.trim() === '') ||
        (typeof v === 'object' && isEmptyContainer(v))
      ) {
        delete rec[key]
      } else if (typeof v === 'object') {
        rec[key] = recursivelyRemoveEmptyValues(v)
        if (isEmptyContainer(rec[key])) delete rec[key]
      }
    }
  }
  return obj
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- yaml-emit`
Expected: PASS (6 tests).

- [ ] **Step 6: Type-check**

Run: `npx tsc -b` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json web/src/lib/yaml-emit.ts web/src/lib/yaml-emit.test.ts
git commit -m "feat(web): add yaml-emit (dump + recursivelyRemoveEmptyValues)"
```

---

## Task 2: Validators

**Files:**
- Create: `web/src/lib/validation.ts`
- Create: `web/src/lib/validation.test.ts`

**Interfaces:**
- Produces:
  - `validateGoDuration(value: string): { valid: boolean; error?: string }`
  - `validateResourceName(value: string): string | null` (returns error message, or `null` if valid)
  - `validateStatusCodes(value: string): string | null`
  - `requiredError(value: string): string | null`
  - `integerError(value: string): string | null`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/validation.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import {
  validateGoDuration,
  validateResourceName,
  validateStatusCodes,
  requiredError,
  integerError,
} from './validation'

describe('validateGoDuration', () => {
  it('accepts ordered unit combinations', () => {
    for (const d of ['30s', '1h', '1h30m', '500ms', '1m30s', '10s', '15m']) {
      expect(validateGoDuration(d).valid, d).toBe(true)
    }
  })
  it('accepts empty string (required-ness gated separately)', () => {
    expect(validateGoDuration('').valid).toBe(true)
  })
  it('rejects out-of-order and repeated units', () => {
    expect(validateGoDuration('1s1h').valid).toBe(false)
    expect(validateGoDuration('1m1m').valid).toBe(false)
  })
  it('rejects arbitrary text', () => {
    const r = validateGoDuration('nope')
    expect(r.valid).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe('validateResourceName', () => {
  it('accepts lowercase dns-ish names', () => {
    expect(validateResourceName('order-store')).toBeNull()
  })
  it('rejects empty, spaces, bad chars, and non-letter starts', () => {
    expect(validateResourceName('')).toMatch(/required/i)
    expect(validateResourceName('a b')).toMatch(/space/i)
    expect(validateResourceName('a_b')).toMatch(/alphanumeric/i)
    expect(validateResourceName('1abc')).toMatch(/start/i)
  })
})

describe('validateStatusCodes', () => {
  it('accepts CSV of codes and ranges', () => {
    expect(validateStatusCodes('200,404,500-503')).toBeNull()
    expect(validateStatusCodes('')).toBeNull() // optional
  })
  it('rejects malformed input', () => {
    expect(validateStatusCodes('200,abc')).toBeTruthy()
    expect(validateStatusCodes('200-')).toBeTruthy()
  })
})

describe('requiredError / integerError', () => {
  it('requiredError flags empty', () => {
    expect(requiredError('')).toMatch(/required/i)
    expect(requiredError('x')).toBeNull()
  })
  it('integerError flags non-integers, allows empty', () => {
    expect(integerError('')).toBeNull()
    expect(integerError('3')).toBeNull()
    expect(integerError('-1')).toBeNull()
    expect(integerError('1.5')).toMatch(/integer/i)
    expect(integerError('x')).toMatch(/integer/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- validation`
Expected: FAIL — cannot resolve `./validation`.

- [ ] **Step 3: Implement**

Create `web/src/lib/validation.ts`:
```ts
// Go duration: optional units in strict descending order, no repetition.
// Ported from cloudgrid utils/validateGoDuration.ts. Empty string is valid
// (required-ness is enforced separately by requiredError).
const DURATION_RE = /^(\d+h)?(\d+m)?(\d+s)?(\d+ms)?(\d+[uµ]s)?(\d+ns)?$/
const UNIT_ORDER = ['h', 'm', 's', 'ms', 'us', 'µs', 'ns']

export function validateGoDuration(value: string): { valid: boolean; error?: string } {
  const err = 'Enter a Go duration like 30s, 5m, 1h30m (units in order h→m→s→ms→us→ns, no repeats)'
  const matches = value.match(DURATION_RE)
  if (!matches) return { valid: false, error: err }
  let lastIndex = -1
  for (let i = 1; i < matches.length; i++) {
    const m = matches[i]
    if (!m) continue
    let unit: string
    if (m.endsWith('ms')) unit = 'ms'
    else if (m.endsWith('us')) unit = 'us'
    else if (m.endsWith('µs')) unit = 'µs'
    else if (m.endsWith('ns')) unit = 'ns'
    else unit = UNIT_ORDER.find((u) => m.endsWith(u)) as string
    const idx = UNIT_ORDER.indexOf(unit)
    if (idx <= lastIndex) return { valid: false, error: err }
    lastIndex = idx
  }
  return { valid: true }
}

// Ported from cloudgrid ConductorResourceMetadataSchema name rules.
export function validateResourceName(value: string): string | null {
  if (!value) return 'Name is required'
  if (value.includes(' ')) return 'Name cannot contain spaces'
  if (/[^a-zA-Z0-9-]/.test(value)) return 'Only alphanumeric characters and hyphens are allowed'
  if (/^[^a-zA-Z]/.test(value)) return 'Name must start with a letter'
  return null
}

// CSV of HTTP/gRPC status codes or ranges, e.g. "200,404,500-503". Optional.
export function validateStatusCodes(value: string): string | null {
  if (value.trim() === '') return null
  const parts = value.split(',').map((p) => p.trim())
  const seg = /^\d{1,3}(-\d{1,3})?$/
  if (!parts.every((p) => seg.test(p))) return 'Use comma-separated codes or ranges, e.g. 200,404,500-503'
  return null
}

export function requiredError(value: string): string | null {
  return value.trim() === '' ? 'This field is required' : null
}

export function integerError(value: string): string | null {
  if (value.trim() === '') return null
  return /^-?\d+$/.test(value.trim()) ? null : 'Must be an integer'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- validation`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/validation.ts web/src/lib/validation.test.ts
git commit -m "feat(web): add builder validators (go-duration, name, status-codes)"
```

---

## Task 3: Download helper

**Files:**
- Create: `web/src/lib/download.ts`
- Create: `web/src/lib/download.test.ts`

**Interfaces:**
- Produces: `downloadText(filename: string, text: string): void`.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/download.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadText } from './download'

describe('downloadText', () => {
  beforeEach(() => {
    // jsdom lacks these; stub them.
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it('creates an anchor with the given filename and clicks it', () => {
    const click = vi.fn()
    const orig = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = orig(tag) as HTMLElement
      if (tag === 'a') (el as HTMLAnchorElement).click = click
      return el
    })
    downloadText('order.yaml', 'a: 1\n')
    const anchor = spy.mock.results.map((r) => r.value as HTMLElement).find((e) => e.tagName === 'A') as HTMLAnchorElement
    expect(anchor.download).toBe('order.yaml')
    expect(anchor.href).toContain('blob:mock')
    expect(click).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- download`
Expected: FAIL — cannot resolve `./download`.

- [ ] **Step 3: Implement**

Create `web/src/lib/download.ts`:
```ts
/** Trigger a client-side download of `text` as a file named `filename`. */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- download`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/download.ts web/src/lib/download.test.ts
git commit -m "feat(web): add downloadText helper"
```

---

## Task 4: Data types + default factories

**Files:**
- Create: `web/src/types/component.ts`
- Create: `web/src/types/resiliency.ts`
- Modify: `web/src/types/metadata.ts`
- Create: `web/src/types/builders.test.ts`

**Interfaces:**
- Produces:
  - `types/component.ts`: `ComponentSpec`, `ComponentMetadataItem`, `defaultComponentSpec(): ComponentSpec`.
  - `types/resiliency.ts`: `DaprResiliency`, `Policies`, `Targets`, `RetryPolicy`, `CircuitBreakerPolicy`, `AppTarget`, `ActorTarget`, `ComponentTarget`, `defaultResiliencyConfig(): DaprResiliency`.
  - `types/metadata.ts`: adds `AuthenticationProfile`, and `authenticationProfiles?`, on `ComponentMetadataSchema`; adds `isCert?`, `binding?` on `MetadataField`.
- Consumes: existing `MetadataField`, `ComponentMetadataSchema` from `types/metadata.ts`.

- [ ] **Step 1: Write the failing test**

Create `web/src/types/builders.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { defaultComponentSpec } from './component'
import { defaultResiliencyConfig } from './resiliency'

describe('defaultComponentSpec', () => {
  it('returns a v1alpha1 Component skeleton', () => {
    const c = defaultComponentSpec()
    expect(c.apiVersion).toBe('dapr.io/v1alpha1')
    expect(c.kind).toBe('Component')
    expect(c.metadata).toEqual({ name: '', namespace: 'default' })
    expect(c.scopes).toEqual([])
    expect(c.spec).toEqual({ type: '', version: '', metadata: [] })
  })
  it('returns a fresh object each call (no shared refs)', () => {
    const a = defaultComponentSpec()
    const b = defaultComponentSpec()
    expect(a.spec.metadata).not.toBe(b.spec.metadata)
  })
})

describe('defaultResiliencyConfig', () => {
  it('returns a v1alpha1 Resiliency skeleton with empty policy/target maps', () => {
    const r = defaultResiliencyConfig()
    expect(r.apiVersion).toBe('dapr.io/v1alpha1')
    expect(r.kind).toBe('Resiliency')
    expect(r.metadata).toEqual({ name: '', namespace: '' })
    expect(r.spec.policies).toEqual({ timeouts: {}, retries: {}, circuitBreakers: {} })
    expect(r.spec.targets).toEqual({ apps: {}, actors: {}, components: {} })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- builders`
Expected: FAIL — cannot resolve `./component` / `./resiliency`.

- [ ] **Step 3: Extend `types/metadata.ts`**

Add to `web/src/types/metadata.ts` (append the new interface and two optional fields; keep existing content):
```ts
export interface AuthenticationProfile {
  title: string
  description?: string
  metadata: MetadataField[]
}
```
And extend the existing interfaces:
- On `MetadataField`, add: `isCert?: boolean` and `binding?: { input?: boolean; output?: boolean }`.
- On `ComponentMetadataSchema`, add: `authenticationProfiles?: AuthenticationProfile[]`.

Resulting `MetadataField` and `ComponentMetadataSchema`:
```ts
export interface MetadataField {
  name: string
  type?: 'string' | 'number' | 'bool' | 'duration'
  description?: string
  required?: boolean
  sensitive?: boolean
  default?: string
  example?: string
  allowedValues?: string[]
  isCert?: boolean
  binding?: { input?: boolean; output?: boolean }
  url?: { title: string; url: string }
}

export interface ComponentMetadataSchema {
  type: string
  name: string
  version: string
  title: string
  status: string
  description?: string
  metadata?: MetadataField[]
  authenticationProfiles?: AuthenticationProfile[]
}
```

- [ ] **Step 4: Create `types/component.ts`**

```ts
export interface ComponentMetadataItem {
  name: string
  value?: string | number | boolean
  secretKeyRef?: { name: string; key: string }
}

export interface ComponentSpec {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace: string; [key: string]: unknown }
  scopes: string[]
  spec: {
    type: string
    version: string
    metadata: ComponentMetadataItem[]
  }
}

export function defaultComponentSpec(): ComponentSpec {
  return {
    apiVersion: 'dapr.io/v1alpha1',
    kind: 'Component',
    metadata: { name: '', namespace: 'default' },
    scopes: [],
    spec: { type: '', version: '', metadata: [] },
  }
}
```

- [ ] **Step 5: Create `types/resiliency.ts`**

Note: cloudgrid's type had a typo `grcpStatusCodes`; this port uses the correct `grpcStatusCodes` consistently.
```ts
export interface RetryPolicy {
  policy?: 'constant' | 'exponential'
  duration?: string
  maxRetries?: number
  maxInterval?: string
  matching?: { httpStatusCodes?: string; grpcStatusCodes?: string }
}

export interface CircuitBreakerPolicy {
  maxRequests?: number
  timeout?: string
  trip?: string
  interval?: string
}

export type TimeoutPolicy = { [name: string]: string }

export interface Policies {
  timeouts: TimeoutPolicy
  retries: { [name: string]: RetryPolicy }
  circuitBreakers: { [name: string]: CircuitBreakerPolicy }
}

export interface AppTarget {
  timeout?: string
  retry?: string
  circuitBreaker?: string
}

export interface ActorTarget {
  timeout?: string
  retry?: string
  circuitBreaker?: string
  circuitBreakerScope?: 'type' | 'id' | 'both' | ''
  circuitBreakerCacheSize?: number
}

export interface ComponentTarget {
  outbound?: { timeout?: string; retry?: string; circuitBreaker?: string }
  inbound?: { timeout?: string; retry?: string; circuitBreaker?: string }
}

export interface Targets {
  apps?: { [name: string]: AppTarget }
  actors?: { [name: string]: ActorTarget }
  components?: { [name: string]: ComponentTarget }
}

export interface DaprResiliency {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace?: string; [key: string]: unknown }
  scopes: string[]
  spec: { policies: Policies; targets: Targets }
}

export function defaultResiliencyConfig(): DaprResiliency {
  return {
    apiVersion: 'dapr.io/v1alpha1',
    kind: 'Resiliency',
    metadata: { name: '', namespace: '' },
    scopes: [],
    spec: {
      policies: { timeouts: {}, retries: {}, circuitBreakers: {} },
      targets: { apps: {}, actors: {}, components: {} },
    },
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- builders`
Expected: PASS.

- [ ] **Step 7: Type-check + full suite (metadata.ts is imported widely)**

Run: `npx tsc -b` → exit 0. Then `npm test` → all green (extending `MetadataField`/`ComponentMetadataSchema` with optional fields must not break existing consumers like `useComponentCatalog`, `MetadataFieldInput`).

- [ ] **Step 8: Commit**

```bash
git add web/src/types/component.ts web/src/types/resiliency.ts web/src/types/metadata.ts web/src/types/builders.test.ts
git commit -m "feat(web): add component/resiliency types + default factories; extend metadata types"
```

---

## Task 5: Controlled form controls

**Files:**
- Create: `web/src/components/form/Field.tsx`
- Create: `web/src/components/form/TextInput.tsx`
- Create: `web/src/components/form/NumberInput.tsx`
- Create: `web/src/components/form/SelectInput.tsx`
- Create: `web/src/components/form/Toggle.tsx`
- Create: `web/src/components/form/index.ts`
- Create: `web/src/components/form/form.test.tsx`

**Interfaces:**
- Produces (all controlled, styled with existing theme.css `.field`/`.inp`/`.select`/`.field-err`/`.req` classes):
  - `Field({ label, htmlFor?, required?, error?, children })`
  - `TextInput({ id?, value, onChange, placeholder?, type?, 'aria-label'? })` — `onChange(value: string)`
  - `NumberInput({ id?, value, onChange, placeholder? })` — `onChange(value: string)` (string-typed to allow empty)
  - `SelectInput({ id?, value, onChange, options, 'aria-label'? })` — `options: { label: string; value: string }[]`
  - `Toggle({ id?, checked, onChange, label })` — `onChange(checked: boolean)`

- [ ] **Step 1: Write the failing test**

Create `web/src/components/form/form.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Field, TextInput, NumberInput, SelectInput, Toggle } from './index'

describe('Field', () => {
  it('renders label, required marker, and error', () => {
    render(<Field label="Name" required error="bad"><input aria-label="Name" /></Field>)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('*')).toBeInTheDocument()
    expect(screen.getByText('bad')).toBeInTheDocument()
  })
})

describe('TextInput', () => {
  it('is controlled and reports string values', () => {
    const onChange = vi.fn()
    render(<TextInput value="a" onChange={onChange} aria-label="f" />)
    fireEvent.change(screen.getByLabelText('f'), { target: { value: 'ab' } })
    expect(onChange).toHaveBeenCalledWith('ab')
  })
})

describe('SelectInput', () => {
  it('renders options and reports the chosen value', () => {
    const onChange = vi.fn()
    render(
      <SelectInput value="" onChange={onChange} aria-label="pick"
        options={[{ label: 'One', value: '1' }, { label: 'Two', value: '2' }]} />,
    )
    fireEvent.change(screen.getByLabelText('pick'), { target: { value: '2' } })
    expect(onChange).toHaveBeenCalledWith('2')
  })
})

describe('Toggle', () => {
  it('reports boolean changes', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} label="on" />)
    fireEvent.click(screen.getByLabelText('on'))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('NumberInput', () => {
  it('reports raw string value (allowing empty)', () => {
    const onChange = vi.fn()
    render(<NumberInput value="" onChange={onChange} aria-label="n" />)
    fireEvent.change(screen.getByLabelText('n'), { target: { value: '5' } })
    expect(onChange).toHaveBeenCalledWith('5')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- form/form`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Implement the controls**

Create `web/src/components/form/Field.tsx`:
```tsx
interface FieldProps {
  label: string
  htmlFor?: string
  required?: boolean
  error?: string | null
  children: React.ReactNode
}

export function Field({ label, htmlFor, required, error, children }: FieldProps) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="req"> *</span>}
      </label>
      {children}
      {error && <div className="field-err">{error}</div>}
    </div>
  )
}
```

Create `web/src/components/form/TextInput.tsx`:
```tsx
interface TextInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'password'
  'aria-label'?: string
}

export function TextInput({ id, value, onChange, placeholder, type = 'text', ...rest }: TextInputProps) {
  return (
    <input
      id={id}
      className="inp"
      type={type}
      value={value}
      placeholder={placeholder}
      aria-label={rest['aria-label']}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
```

Create `web/src/components/form/NumberInput.tsx`:
```tsx
interface NumberInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  'aria-label'?: string
}

// value is kept as a string so the field can be empty; callers coerce on emit.
export function NumberInput({ id, value, onChange, placeholder, ...rest }: NumberInputProps) {
  return (
    <input
      id={id}
      className="inp"
      type="number"
      value={value}
      placeholder={placeholder}
      aria-label={rest['aria-label']}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
```

Create `web/src/components/form/SelectInput.tsx`:
```tsx
interface SelectOption {
  label: string
  value: string
}

interface SelectInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  'aria-label'?: string
}

export function SelectInput({ id, value, onChange, options, ...rest }: SelectInputProps) {
  return (
    <select
      id={id}
      className="select"
      value={value}
      aria-label={rest['aria-label']}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}
```

Create `web/src/components/form/Toggle.tsx`:
```tsx
interface ToggleProps {
  id?: string
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}

export function Toggle({ id, checked, onChange, label }: ToggleProps) {
  return (
    <label className="childtoggle">
      <input
        id={id}
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}
```

Create `web/src/components/form/index.ts`:
```ts
export { Field } from './Field'
export { TextInput } from './TextInput'
export { NumberInput } from './NumberInput'
export { SelectInput } from './SelectInput'
export { Toggle } from './Toggle'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- form/form`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/form/
git commit -m "feat(web): add controlled form controls (Field/TextInput/NumberInput/SelectInput/Toggle)"
```

---

## Task 6: Wizard shell + monochrome button styles

**Files:**
- Create: `web/src/components/wizard/Stepper.tsx`
- Create: `web/src/components/wizard/StepNav.tsx`
- Create: `web/src/components/wizard/Wizard.tsx`
- Create: `web/src/components/wizard/index.ts`
- Create: `web/src/components/wizard/wizard.test.tsx`
- Modify: `web/src/styles/theme.css` (append wizard styles)

**Interfaces:**
- Produces:
  - `WizardStep = { label: string; content: React.ReactNode }`
  - `Stepper({ steps: { label: string }[], activeStep: number })`
  - `StepNav({ activeStep, stepCount, canContinue, onBack, onContinue, onFinish })` — Back hidden on step 0; last step shows "Finish" (calls `onFinish`), else "Continue" (calls `onContinue`); Continue/Finish disabled when `!canContinue`.
  - `Wizard({ steps: WizardStep[], activeStep, canContinue, onBack, onContinue, onFinish })` — renders `Stepper` + active step content + `StepNav`. Presentational only; state lives in each builder's reducer (Plans 2–3).

- [ ] **Step 1: Write the failing test**

Create `web/src/components/wizard/wizard.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Wizard, StepNav } from './index'

const steps = [
  { label: 'One', content: <div>content-one</div> },
  { label: 'Two', content: <div>content-two</div> },
]

describe('Wizard', () => {
  it('renders step labels and only the active step content', () => {
    render(<Wizard steps={steps} activeStep={0} canContinue onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.getByText('Two')).toBeInTheDocument()
    expect(screen.getByText('content-one')).toBeInTheDocument()
    expect(screen.queryByText('content-two')).not.toBeInTheDocument()
  })
})

describe('StepNav', () => {
  it('hides Back on the first step and shows Continue', () => {
    render(<StepNav activeStep={0} stepCount={2} canContinue onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled()
  })
  it('shows Finish (not Continue) on the last step', () => {
    render(<StepNav activeStep={1} stepCount={2} canContinue onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    expect(screen.getByRole('button', { name: /finish/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument()
  })
  it('disables the primary action when canContinue is false', () => {
    render(<StepNav activeStep={0} stepCount={2} canContinue={false} onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()
  })
  it('primary button uses the monochrome class, never the green .btn.primary', () => {
    render(<StepNav activeStep={0} stepCount={2} canContinue onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    const cont = screen.getByRole('button', { name: /continue/i })
    expect(cont).toHaveClass('btn', 'mono')
    expect(cont).not.toHaveClass('primary')
  })
  it('fires onContinue / onFinish / onBack', () => {
    const onContinue = vi.fn(); const onFinish = vi.fn(); const onBack = vi.fn()
    const { rerender } = render(<StepNav activeStep={0} stepCount={2} canContinue onBack={onBack} onContinue={onContinue} onFinish={onFinish} />)
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(onContinue).toHaveBeenCalledOnce()
    rerender(<StepNav activeStep={1} stepCount={2} canContinue onBack={onBack} onContinue={onContinue} onFinish={onFinish} />)
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    fireEvent.click(screen.getByRole('button', { name: /finish/i }))
    expect(onBack).toHaveBeenCalledOnce()
    expect(onFinish).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- wizard/wizard`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Append wizard styles to `theme.css`**

Append to the end of `web/src/styles/theme.css`:
```css
/* ---- Wizard (component/resiliency builders) ---- */
/* Monochrome primary button — deliberately NOT the green .btn.primary. */
.btn.mono { background: var(--text); color: var(--bg); border-color: transparent; }
.btn.mono:disabled { opacity: .45; cursor: default; }
.wizard { display: flex; flex-direction: column; gap: 18px; }
.stepper { display: flex; flex-wrap: wrap; gap: 8px; }
.stepper .step { font-family: var(--mono); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 4px 11px; }
.stepper .step.active { color: var(--text); border-color: var(--faint); background: var(--surface-2); }
.stepper .step.done { color: var(--accent2); }
.wizard-body { min-height: 120px; }
.stepnav { display: flex; justify-content: space-between; gap: 10px; }
.stepnav .spacer { flex: 1; }
```

- [ ] **Step 4: Implement the components**

Create `web/src/components/wizard/Stepper.tsx`:
```tsx
interface StepperProps {
  steps: { label: string }[]
  activeStep: number
}

export function Stepper({ steps, activeStep }: StepperProps) {
  return (
    <div className="stepper" role="list" aria-label="Wizard steps">
      {steps.map((s, i) => (
        <span
          key={s.label}
          role="listitem"
          aria-current={i === activeStep ? 'step' : undefined}
          className={`step${i === activeStep ? ' active' : ''}${i < activeStep ? ' done' : ''}`}
        >
          {s.label}
        </span>
      ))}
    </div>
  )
}
```

Create `web/src/components/wizard/StepNav.tsx`:
```tsx
interface StepNavProps {
  activeStep: number
  stepCount: number
  canContinue: boolean
  onBack: () => void
  onContinue: () => void
  onFinish: () => void
}

export function StepNav({ activeStep, stepCount, canContinue, onBack, onContinue, onFinish }: StepNavProps) {
  const isLast = activeStep === stepCount - 1
  return (
    <div className="stepnav">
      {activeStep > 0 ? (
        <button type="button" className="btn ghost" onClick={onBack}>Back</button>
      ) : (
        <span className="spacer" />
      )}
      {isLast ? (
        <button type="button" className="btn mono" disabled={!canContinue} onClick={onFinish}>Finish</button>
      ) : (
        <button type="button" className="btn mono" disabled={!canContinue} onClick={onContinue}>Continue</button>
      )}
    </div>
  )
}
```

Create `web/src/components/wizard/Wizard.tsx`:
```tsx
import { Stepper } from './Stepper'
import { StepNav } from './StepNav'

export interface WizardStep {
  label: string
  content: React.ReactNode
}

interface WizardProps {
  steps: WizardStep[]
  activeStep: number
  canContinue: boolean
  onBack: () => void
  onContinue: () => void
  onFinish: () => void
}

export function Wizard({ steps, activeStep, canContinue, onBack, onContinue, onFinish }: WizardProps) {
  return (
    <div className="wizard">
      <Stepper steps={steps.map((s) => ({ label: s.label }))} activeStep={activeStep} />
      <div className="wizard-body">{steps[activeStep]?.content}</div>
      <StepNav
        activeStep={activeStep}
        stepCount={steps.length}
        canContinue={canContinue}
        onBack={onBack}
        onContinue={onContinue}
        onFinish={onFinish}
      />
    </div>
  )
}
```

Create `web/src/components/wizard/index.ts`:
```ts
export { Wizard, type WizardStep } from './Wizard'
export { Stepper } from './Stepper'
export { StepNav } from './StepNav'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- wizard/wizard`
Expected: PASS.

- [ ] **Step 6: Type-check + full suite**

Run: `npx tsc -b` → exit 0. Then `npm test` → all green.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/wizard/ web/src/styles/theme.css
git commit -m "feat(web): add wizard shell (Stepper/StepNav/Wizard) + monochrome button styles"
```

---

## Self-Review

**Spec coverage (foundation portions only; wizard content + routing/nav ship in Plans 2–3):**
- `js-yaml` dep + `lib/yaml-emit.ts` incl. `recursivelyRemoveEmptyValues` → Task 1. ✓
- `lib/validation.ts` (`validateGoDuration` ported verbatim, name + status-code validators) → Task 2. ✓
- `lib/download.ts` → Task 3. ✓
- Types (`component.ts`, `resiliency.ts`, extend `metadata.ts` for `authenticationProfiles`) → Task 4. ✓
- `components/form/` controlled controls → Task 5. ✓
- `components/wizard/` + monochrome button styling (Global Constraint) → Task 6. ✓
- Reuse of existing `Modal`, `MetadataFieldInput`, `copyText`, `useToast`, `highlightYaml`, `fetchJSON` — consumed in Plans 2–3, not rebuilt here. ✓
- **Deferred to Plans 2–3 (documented):** routes `/components/new`, `/resiliency`, `/resiliency/new`; the `Resiliency` nav item; the `+ New component` button; the create-only `Resiliency` landing page; generalizing `useComponentCatalog`; the two 4-step wizard flows and their YAML assembly.

**Placeholder scan:** No TBD/TODO; every code step contains complete code; commands include expected results.

**Type consistency:** `dumpYaml`/`recursivelyRemoveEmptyValues` (Task 1) reused by builders; `validateGoDuration` returns `{valid,error}` and `validateResourceName`/`validateStatusCodes`/`requiredError`/`integerError` return `string|null` (Task 2) — consistent across the plan. `defaultComponentSpec`/`defaultResiliencyConfig` (Task 4) match the types they return. `WizardStep`, `Stepper`, `StepNav`, `Wizard` prop names (Task 6) are consistent between the components and the index re-exports. Form control `onChange` signatures (string for text/number/select, boolean for toggle) are stated in Task 5 interfaces and used consistently.

**Note on grpcStatusCodes:** cloudgrid's type used the typo `grcpStatusCodes`; this port standardizes on `grpcStatusCodes` (Task 4) and Plans 2–3 must use that spelling in the retry-policy form + emit.
