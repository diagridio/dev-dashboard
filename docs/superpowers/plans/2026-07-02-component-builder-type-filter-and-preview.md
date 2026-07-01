# Component Builder — Category Filter + Highlighted Preview + Removable Optionals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the existing Component Builder: a category filter on step 1, removable optional fields on step 3, and a read-only syntax-highlighted YAML preview on step 4 (reusing the Components detail view's rendering).

**Architecture:** Modifies the existing `pages/component-builder/*` and the shared `components/YamlPreview.tsx`. Reducer gains a `category` field + `SELECT_CATEGORY`; `StepType` becomes category-gated; `StepConfigure` reuses the state-connection dialog's add/remove UI; `YamlPreview` becomes read-only via `highlightYaml`. No new dependencies.

**Tech Stack:** React 19, TS, Vite, React Router v6, TanStack Query v5, Vitest + Testing Library.

**Prereq:** Component Builder (Plan 2, `2026-07-01-builders-02-component.md`) complete on this branch.
**Source spec:** `docs/superpowers/specs/2026-07-02-component-builder-type-filter-and-preview-design.md`

## Global Constraints

- No new dependencies. No MUI/react-hook-form/Yup. Controlled components; vanilla CSS theme tokens.
- Monochrome buttons only (`.btn.mono` primary / `.btn.ghost` secondary); never green `.btn.primary`.
- Category chips are single-select, use existing `.filters` container + `.lvchip` buttons with `aria-pressed`.
- Preview reuses the Components detail rendering verbatim: `<pre className="code">{highlightYaml(yaml)}</pre>` (read-only). Copy + Download act on the generated `yaml`.
- Removable optional fields reuse the `StateStoreConnectionDialog.tsx` pattern: a ghost `✕` button `aria-label={`remove ${field}`}` per added optional field, plus the existing `+ add optional field…` select.
- Switching to a different category clears the selected schema + downstream config; `REMOVE_OPTIONAL` clears the field's `values`/`secretRefs`/`useSecret`.
- Tests: Vitest + Testing Library, colocated. Run `npx tsc -b` before every commit. All `npm`/`npx` from `web/`.

---

## File Structure

- Modify `web/src/pages/component-builder/reducer.ts` (+ `reducer.test.ts`) — `category`, `SELECT_CATEGORY`, `SELECT_SCHEMA` sync, `REMOVE_OPTIONAL` clears state.
- Modify `web/src/pages/component-builder/StepType.tsx` (+ `StepType.test.tsx`) — category chips + gated list/search.
- Modify `web/src/pages/component-builder/StepConfigure.tsx` (+ `StepConfigure.test.tsx`) — ✕ remove per added optional field.
- Modify `web/src/components/YamlPreview.tsx` (+ `YamlPreview.test.tsx`) — read-only highlighted.
- Modify `web/src/pages/component-builder/ComponentBuilder.tsx` (+ `ComponentBuilder.test.tsx`) — selection bar; drop `previewEdited`; new preview usage.
- Modify `docs/superpowers/plans/2026-07-01-builders-03-resiliency.md` — read-only `YamlPreview` API (doc-only).

---

## Task 1: Reducer — category + SELECT_CATEGORY + REMOVE_OPTIONAL clears state

**Files:**
- Modify: `web/src/pages/component-builder/reducer.ts`
- Modify: `web/src/pages/component-builder/reducer.test.ts`

**Interfaces:**
- Produces: `ComponentBuilderState` gains `category?: string`; `Action` gains `{ type: 'SELECT_CATEGORY'; category: string }`. `SELECT_SCHEMA` now also sets `category = schema.type`. `REMOVE_OPTIONAL` also deletes the field from `values`/`secretRefs`/`useSecret`.
- Consumes: unchanged (`types/component`, `types/metadata`, `lib/validation`, `activeFields`).

- [ ] **Step 1: Write the failing tests**

Append to `web/src/pages/component-builder/reducer.test.ts`:
```ts
describe('SELECT_CATEGORY', () => {
  const redis = {
    type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
    metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' as const }],
  }
  it('sets the active category', () => {
    const s = reducer(initialState(), { type: 'SELECT_CATEGORY', category: 'state' })
    expect(s.category).toBe('state')
    expect(s.activeStep).toBe(0)
  })
  it('SELECT_SCHEMA sets category = schema.type', () => {
    const s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
    expect(s.category).toBe('state')
  })
  it('switching to a different category clears schema + config', () => {
    let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
    s = reducer(s, { type: 'SET_VALUE', field: 'redisHost', value: 'x' })
    s = reducer(s, { type: 'SELECT_CATEGORY', category: 'pubsub' })
    expect(s.category).toBe('pubsub')
    expect(s.schema).toBeUndefined()
    expect(s.version).toBe('')
    expect(s.values).toEqual({})
  })
  it('re-selecting the same category keeps the schema', () => {
    let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
    s = reducer(s, { type: 'SELECT_CATEGORY', category: 'state' })
    expect(s.schema?.name).toBe('redis')
  })
})

describe('REMOVE_OPTIONAL clears field state', () => {
  it('removes the field from optionalAdded and clears its value/secret/useSecret', () => {
    let s = initialState()
    s = reducer(s, { type: 'ADD_OPTIONAL', field: 'enableTLS' })
    s = reducer(s, { type: 'SET_VALUE', field: 'enableTLS', value: 'true' })
    s = reducer(s, { type: 'TOGGLE_SECRET', field: 'enableTLS', on: true })
    s = reducer(s, { type: 'SET_SECRET', field: 'enableTLS', ref: { name: 'n', key: 'k' } })
    s = reducer(s, { type: 'REMOVE_OPTIONAL', field: 'enableTLS' })
    expect(s.optionalAdded).not.toContain('enableTLS')
    expect(s.values.enableTLS).toBeUndefined()
    expect(s.secretRefs.enableTLS).toBeUndefined()
    expect(s.useSecret.enableTLS).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- component-builder/reducer`
Expected: FAIL — `SELECT_CATEGORY` not handled (category undefined); `REMOVE_OPTIONAL` leaves value set.

- [ ] **Step 3: Implement**

In `web/src/pages/component-builder/reducer.ts`:

Add `category?: string` to the `ComponentBuilderState` interface (after `activeStep`):
```ts
export interface ComponentBuilderState {
  activeStep: number
  category?: string
  schema?: ComponentMetadataSchema
  // …rest unchanged…
}
```

Add to the `Action` union:
```ts
  | { type: 'SELECT_CATEGORY'; category: string }
```

Update the `SELECT_SCHEMA` case to also set `category`:
```ts
    case 'SELECT_SCHEMA': {
      const hasAuthProfiles = (action.schema.authenticationProfiles?.length ?? 0) > 0
      return {
        ...state,
        category: action.schema.type,
        schema: action.schema,
        version: action.version,
        hasAuthProfiles,
        activeStep: 1,
      }
    }
```

Add the `SELECT_CATEGORY` case (place it before `SET_AUTH_PROFILE`):
```ts
    case 'SELECT_CATEGORY':
      if (action.category === state.schema?.type) {
        return { ...state, category: action.category }
      }
      // Switching category invalidates the chosen component + its config.
      return {
        ...state,
        category: action.category,
        schema: undefined,
        version: '',
        authProfile: undefined,
        hasAuthProfiles: false,
        values: {},
        secretRefs: {},
        useSecret: {},
        optionalAdded: [],
      }
```

Replace the `REMOVE_OPTIONAL` case:
```ts
    case 'REMOVE_OPTIONAL': {
      const values = { ...state.values }
      const secretRefs = { ...state.secretRefs }
      const useSecret = { ...state.useSecret }
      delete values[action.field]
      delete secretRefs[action.field]
      delete useSecret[action.field]
      return {
        ...state,
        optionalAdded: state.optionalAdded.filter((f) => f !== action.field),
        values,
        secretRefs,
        useSecret,
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- component-builder/reducer`
Expected: PASS (existing + new).

- [ ] **Step 5: Type-check + full suite**

Run: `npx tsc -b` → 0. Then `npm test` → all green (the new optional `category` and unused-yet `SELECT_CATEGORY` don't affect existing consumers).

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/component-builder/reducer.ts web/src/pages/component-builder/reducer.test.ts
git commit -m "feat(web): component builder reducer gains category + SELECT_CATEGORY; REMOVE_OPTIONAL clears field state"
```

---

## Task 2: StepType — category chips gate the list + search

**Files:**
- Modify: `web/src/pages/component-builder/StepType.tsx`
- Modify: `web/src/pages/component-builder/StepType.test.tsx`
- Modify: `web/src/pages/component-builder/ComponentBuilder.test.tsx` (add the category-select step so the integration walk stays green)

**Interfaces:**
- Consumes: `useComponentSchemas` (`byType`), reducer `Action`/`ComponentBuilderState` (incl. `category`, `SELECT_CATEGORY`).
- Produces: `StepType` renders category chips; before a category is chosen shows a hint; after, shows the scoped search + filtered list.

- [ ] **Step 1: Rewrite the StepType test**

Replace `web/src/pages/component-builder/StepType.test.tsx` with:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { QueryProvider, makeQueryClient } from '../../lib/query'
import { StepType } from './StepType'
import { initialState, reducer } from './reducer'
import type { ComponentBuilderState } from './reducer'

const bundle = {
  schemaVersion: '1', date: '2026-01-01',
  components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable', metadata: [] },
    { type: 'state', name: 'postgresql', version: 'v1', title: 'PostgreSQL', status: 'stable', metadata: [] },
    { type: 'pubsub', name: 'kafka', version: 'v1', title: 'Apache Kafka', status: 'stable', metadata: [] },
  ],
}

function renderStep(state: ComponentBuilderState, dispatch = vi.fn()) {
  server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
  return render(
    <QueryProvider client={makeQueryClient()}>
      <StepType state={state} dispatch={dispatch} />
    </QueryProvider>,
  )
}

describe('StepType category filter', () => {
  it('shows category chips and a hint before any category is chosen', async () => {
    renderStep(initialState())
    expect(await screen.findByRole('button', { name: 'state' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pubsub' })).toBeInTheDocument()
    expect(screen.getByText(/choose a category/i)).toBeInTheDocument()
    expect(screen.queryByText('Redis')).not.toBeInTheDocument()
  })

  it('clicking a category chip dispatches SELECT_CATEGORY', async () => {
    const dispatch = vi.fn()
    renderStep(initialState(), dispatch)
    fireEvent.click(await screen.findByRole('button', { name: 'state' }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'SELECT_CATEGORY', category: 'state' })
  })

  it('with a category selected, lists only that category and scopes search', async () => {
    const state = reducer(initialState(), { type: 'SELECT_CATEGORY', category: 'state' })
    renderStep(state)
    expect(await screen.findByText('Redis')).toBeInTheDocument()
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument()
    expect(screen.queryByText('Apache Kafka')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'postgres' } })
    expect(screen.queryByText('Redis')).not.toBeInTheDocument()
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument()
  })

  it('clicking a component dispatches SELECT_SCHEMA with its version', async () => {
    const dispatch = vi.fn()
    const state = reducer(initialState(), { type: 'SELECT_CATEGORY', category: 'state' })
    renderStep(state, dispatch)
    fireEvent.click(await screen.findByText('Redis'))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SELECT_SCHEMA', version: 'v1' }))
    expect(dispatch.mock.calls.at(-1)?.[0].schema.name).toBe('redis')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- component-builder/StepType`
Expected: FAIL — chips not rendered; hint absent.

- [ ] **Step 3: Rewrite `StepType.tsx`**

Replace `web/src/pages/component-builder/StepType.tsx` with:
```tsx
import { useState } from 'react'
import { useComponentSchemas } from '../../hooks/useComponentSchemas'
import type { Action, ComponentBuilderState } from './reducer'

interface Props {
  state: ComponentBuilderState
  dispatch: (a: Action) => void
}

export function StepType({ state, dispatch }: Props) {
  const { byType, isLoading } = useComponentSchemas()
  const [q, setQ] = useState('')

  if (isLoading) return <p className="muted">Loading catalog…</p>

  const categories = Object.keys(byType).sort()
  const category = state.category
  const query = q.trim().toLowerCase()

  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            className="lvchip"
            aria-pressed={category === c}
            onClick={() => dispatch({ type: 'SELECT_CATEGORY', category: c })}
          >
            {c}
          </button>
        ))}
      </div>

      {!category ? (
        <p className="muted">Choose a category to browse components.</p>
      ) : (
        <>
          <div className="search" style={{ marginBottom: 12 }}>
            <input
              type="search"
              aria-label="Search components"
              placeholder={`Search ${category} components…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="complist card">
            {(byType[category] ?? [])
              .filter((s) => !query || s.title.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
              .map((s) => {
                const selected = state.schema?.type === s.type && state.schema?.name === s.name
                return (
                  <div
                    key={`${s.type}.${s.name}`}
                    className={`ci${selected ? ' sel' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => dispatch({ type: 'SELECT_SCHEMA', schema: s, version: s.version })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') dispatch({ type: 'SELECT_SCHEMA', schema: s, version: s.version })
                    }}
                  >
                    <span className="cn">{s.title}</span>
                    <span className="ct">{`${s.type}.${s.name}`} · {s.version} · {s.status}</span>
                  </div>
                )
              })}
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the StepType test to verify it passes**

Run: `npm test -- component-builder/StepType`
Expected: PASS.

- [ ] **Step 5: Keep the integration test green (category-first)**

The `ComponentBuilder.test.tsx` walk clicks "Redis" directly; now a category must be chosen first. In `web/src/pages/component-builder/ComponentBuilder.test.tsx`, insert a category-chip click immediately before the line that clicks `Redis`:
```tsx
    fireEvent.click(await screen.findByRole('button', { name: 'state' })) // pick category
    fireEvent.click(await screen.findByText('Redis'))                     // then component
```
(Leave the rest of that test unchanged for now — Task 4 updates the preview assertion.)

- [ ] **Step 6: Full suite + type-check**

Run: `npm test` → all green. Run: `npx tsc -b` → 0.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/component-builder/StepType.tsx web/src/pages/component-builder/StepType.test.tsx web/src/pages/component-builder/ComponentBuilder.test.tsx
git commit -m "feat(web): component builder Step 1 category filter chips"
```

---

## Task 3: StepConfigure — removable optional fields

**Files:**
- Modify: `web/src/pages/component-builder/StepConfigure.tsx`
- Modify: `web/src/pages/component-builder/StepConfigure.test.tsx`

**Interfaces:**
- Consumes: reducer `REMOVE_OPTIONAL` (now clears field state), `activeFields`, form components, `MetadataFieldInput`.
- Produces: each added optional field row shows a ✕ remove button (`aria-label={`remove ${field}`}`).

- [ ] **Step 1: Add the failing test**

Append to `web/src/pages/component-builder/StepConfigure.test.tsx` (reuse the existing `redis`/`configureState` helpers in that file; the redis schema there has optional `enableTLS`):
```tsx
describe('StepConfigure optional field removal', () => {
  it('shows a remove button for an added optional field and dispatches REMOVE_OPTIONAL', () => {
    const dispatch = vi.fn()
    let s = configureState()
    s = reducer(s, { type: 'ADD_OPTIONAL', field: 'enableTLS' })
    render(<StepConfigure state={s} dispatch={dispatch} />)
    const removeBtn = screen.getByRole('button', { name: /remove enableTLS/i })
    fireEvent.click(removeBtn)
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_OPTIONAL', field: 'enableTLS' })
  })

  it('does not show a remove button for required fields', () => {
    render(<StepConfigure state={configureState()} dispatch={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /remove redisHost/i })).not.toBeInTheDocument()
  })
})
```
If the existing test file does not already import `reducer`, add `reducer` to its import from `./reducer`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- component-builder/StepConfigure`
Expected: FAIL — no remove button.

- [ ] **Step 3: Update `StepConfigure.tsx`**

Replace the `shown.map(...)` block in `web/src/pages/component-builder/StepConfigure.tsx` with one that wraps the value control + ✕ in a `.field-row` and shows ✕ for non-required (optional-added) fields:
```tsx
      <div className="sec-title">Metadata</div>
      {shown.map((f) => {
        const useSecret = !!state.useSecret[f.name]
        const ref = state.secretRefs[f.name] ?? { name: '', key: '' }
        const removable = !f.required
        return (
          <Field key={f.name} label={f.name} required={f.required}>
            {f.description && <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{f.description}</div>}
            <Toggle
              label={`Use secret for ${f.name}`}
              checked={useSecret}
              onChange={(on) => dispatch({ type: 'TOGGLE_SECRET', field: f.name, on })}
            />
            <div className="field-row">
              {useSecret ? (
                <>
                  <TextInput aria-label={`${f.name} secret name`} placeholder="secret name" value={ref.name}
                    onChange={(v) => dispatch({ type: 'SET_SECRET', field: f.name, ref: { ...ref, name: v } })} />
                  <TextInput aria-label={`${f.name} secret key`} placeholder="secret key" value={ref.key}
                    onChange={(v) => dispatch({ type: 'SET_SECRET', field: f.name, ref: { ...ref, key: v } })} />
                </>
              ) : (
                <MetadataFieldInput field={f} value={state.values[f.name] ?? ''} onChange={(v) => dispatch({ type: 'SET_VALUE', field: f.name, value: v })} />
              )}
              {removable && (
                <button type="button" className="btn ghost" aria-label={`remove ${f.name}`}
                  onClick={() => dispatch({ type: 'REMOVE_OPTIONAL', field: f.name })}>✕</button>
              )}
            </div>
          </Field>
        )
      })}
```
(The `+ add optional field…` `SelectInput` block below stays unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- component-builder/StepConfigure`
Expected: PASS (existing + new).

- [ ] **Step 5: Full suite + type-check**

Run: `npm test` → green. Run: `npx tsc -b` → 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/component-builder/StepConfigure.tsx web/src/pages/component-builder/StepConfigure.test.tsx
git commit -m "feat(web): component builder Step 3 removable optional fields"
```

---

## Task 4: Read-only highlighted preview + ComponentBuilder selection bar

**Files:**
- Modify: `web/src/components/YamlPreview.tsx`
- Modify: `web/src/components/YamlPreview.test.tsx`
- Modify: `web/src/pages/component-builder/ComponentBuilder.tsx`
- Modify: `web/src/pages/component-builder/ComponentBuilder.test.tsx`
- Modify: `docs/superpowers/plans/2026-07-01-builders-03-resiliency.md`

**Interfaces:**
- Produces: `YamlPreview({ yaml, filename })` — read-only, `<pre className="code">{highlightYaml(yaml)}</pre>` + Copy/Download. No `onEditedChange`. `ComponentBuilder` renders a persistent selection bar and passes `yaml`/`filename` only.
- Consumes: `lib/yaml-highlight` `highlightYaml`, `lib/clipboard` `copyText`, `lib/toast` `useToast`, `lib/download` `downloadText`, reducer `state.category`/`state.schema`.

- [ ] **Step 1: Rewrite the YamlPreview test**

Replace `web/src/components/YamlPreview.test.tsx` with:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { YamlPreview } from './YamlPreview'
import { copyText } from '../lib/clipboard'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))

describe('YamlPreview (read-only)', () => {
  beforeEach(() => {
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it('renders the yaml read-only in a <pre> (no textbox)', () => {
    const { container } = render(<YamlPreview yaml={'a: 1\nb: x\n'} filename="c.yaml" />)
    const pre = container.querySelector('pre.code')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('a: 1')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('Copy copies the yaml', () => {
    render(<YamlPreview yaml={'a: 1\n'} filename="c.yaml" />)
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))
    expect(copyText).toHaveBeenCalledWith('a: 1\n')
  })

  it('Download uses the monochrome class and triggers a download', () => {
    render(<YamlPreview yaml={'a: 1\n'} filename="order.yaml" />)
    const dl = screen.getByRole('button', { name: /download/i })
    expect(dl).toHaveClass('btn', 'mono')
    fireEvent.click(dl)
    expect(URL.createObjectURL).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- YamlPreview`
Expected: FAIL — current YamlPreview renders a textbox / exports the old API.

- [ ] **Step 3: Rewrite `YamlPreview.tsx`**

Replace `web/src/components/YamlPreview.tsx` with:
```tsx
import { highlightYaml } from '../lib/yaml-highlight'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import { downloadText } from '../lib/download'

interface YamlPreviewProps {
  yaml: string
  filename: string
}

export function YamlPreview({ yaml, filename }: YamlPreviewProps) {
  const { toast, toastNode } = useToast()
  return (
    <div>
      <pre className="code">{highlightYaml(yaml)}</pre>
      <div className="stepnav" style={{ marginTop: 10 }}>
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={() => { copyText(yaml); toast.show('Copied') }}>
          Copy
        </button>
        <button type="button" className="btn mono" onClick={() => downloadText(filename, yaml)}>
          Download
        </button>
      </div>
      {toastNode}
    </div>
  )
}
```

- [ ] **Step 4: Update `ComponentBuilder.tsx`**

Replace `web/src/pages/component-builder/ComponentBuilder.tsx` with (drops `previewEdited`; adds selection bar; new preview usage):
```tsx
import { useMemo, useReducer } from 'react'
import { useNavigate } from 'react-router-dom'
import { Wizard, type WizardStep } from '../../components/wizard'
import { YamlPreview } from '../../components/YamlPreview'
import { dumpYaml } from '../../lib/yaml-emit'
import { initialState, reducer, canContinue, assembleComponentSpec } from './reducer'
import { StepType } from './StepType'
import { StepAuth } from './StepAuth'
import { StepConfigure } from './StepConfigure'

export function ComponentBuilder() {
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(reducer, undefined, initialState)

  const yaml = useMemo(
    () => (state.activeStep === 3 ? dumpYaml(assembleComponentSpec(state)) : ''),
    [state],
  )

  const steps: WizardStep[] = [
    { label: 'Type', content: <StepType state={state} dispatch={dispatch} /> },
    { label: 'Auth', content: <StepAuth state={state} dispatch={dispatch} /> },
    { label: 'Configure', content: <StepConfigure state={state} dispatch={dispatch} /> },
    { label: 'Preview', content: <YamlPreview yaml={yaml} filename={`${state.name || 'component'}.yaml`} /> },
  ]

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>New component</h1>
          <div className="sub">Build a Dapr component YAML to copy or download</div>
        </div>
        <button type="button" className="btn ghost" onClick={() => navigate('/components')}>Cancel</button>
      </div>
      {(state.category || state.schema) && (
        <div className="crumbs" aria-label="Selected component" style={{ marginBottom: 12 }}>
          {state.category && <span className="typechip">{state.category}</span>}
          {state.schema && <span className="b">{state.schema.title} · {state.version}</span>}
        </div>
      )}
      <div className="card" style={{ padding: 18 }}>
        <Wizard
          steps={steps}
          activeStep={state.activeStep}
          canContinue={canContinue(state)}
          onBack={() => dispatch({ type: 'BACK' })}
          onContinue={() => dispatch({ type: 'NEXT' })}
          onFinish={() => navigate('/components')}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Update the ComponentBuilder integration test**

In `web/src/pages/component-builder/ComponentBuilder.test.tsx`: the Preview step is now a read-only `<pre>`, not a textbox. Replace the preview assertions (the `getByRole('textbox', { name: /generated yaml/i })` reads) with reads of the `<pre>` text, and **delete the back-then-forward Finish probe** (there is no editable buffer any more). The final assertions become:
```tsx
    // after Continue into Preview:
    await screen.findByText(/kind: Component/i) // highlighted YAML is present
    const pre = document.querySelector('pre.code') as HTMLPreElement
    expect(pre.textContent).toContain('type: state.redis')
    expect(pre.textContent).toContain('name: order-store')
    expect(screen.getByRole('button', { name: /finish/i })).toBeEnabled()
```
Keep the earlier steps (category click, Redis click, Continue past Auth, fill Name + redisHost, Continue) as-is. If `findByText(/kind: Component/i)` is split across highlight spans and does not match, fall back to `await waitFor(() => expect(document.querySelector('pre.code')?.textContent).toContain('kind: Component'))` (import `waitFor`).

- [ ] **Step 6: Update the Plan 3 doc for the read-only YamlPreview API**

In `docs/superpowers/plans/2026-07-01-builders-03-resiliency.md`, Task 5 uses `YamlPreview` with `onEditedChange`/`previewEdited` gating in `ResiliencyBuilder.tsx`. Update that task's code and prose to the read-only API: `<YamlPreview yaml={yaml} filename={...} />` (no `onEditedChange`), remove the `previewEdited` state and the `state.activeStep === 3 ? !previewEdited : canContinue(state)` clause (use `canContinue(state)` directly; Finish always enabled on the preview step). This is a documentation edit only — no Plan 3 code exists yet.

- [ ] **Step 7: Run the touched tests, full suite, type-check**

Run: `npm test -- YamlPreview component-builder/ComponentBuilder` → PASS.
Run: `npm test` → all green. Run: `npx tsc -b` → 0.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/YamlPreview.tsx web/src/components/YamlPreview.test.tsx web/src/pages/component-builder/ComponentBuilder.tsx web/src/pages/component-builder/ComponentBuilder.test.tsx docs/superpowers/plans/2026-07-01-builders-03-resiliency.md
git commit -m "feat(web): read-only highlighted preview + builder selection bar; update Plan 3 doc"
```

---

## Self-Review

**Spec coverage:**
- Category filter chips on step 1 + scoped search + "pick a category" hint → Task 2. ✓
- Selected category + component visible across steps (selection bar) → Task 4 (`ComponentBuilder`). ✓
- Switching category clears schema + config → Task 1 (`SELECT_CATEGORY`). ✓
- Removable optional fields (reuse state-connection dialog ✕ pattern) → Task 3 + `REMOVE_OPTIONAL` clears field state (Task 1). ✓
- Read-only highlighted preview (reuse `highlightYaml`/`pre.code`), Copy + Download → Task 4. ✓
- Drop `previewEdited` gate; Finish always enabled → Task 4. ✓
- Plan 3 doc updated to read-only `YamlPreview` → Task 4 Step 6. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code + commands with expected results. The `findByText(/kind: Component/i)` fallback in Task 4 Step 5 is a stated contingency (highlight-span splitting), with the exact alternative given — not a placeholder.

**Type consistency:** `category?: string` + `SELECT_CATEGORY` (Task 1) consumed by StepType (Task 2) and the selection bar (Task 4) with matching names. `REMOVE_OPTIONAL` payload `{ field }` consistent between reducer (Task 1), StepConfigure (Task 3), and tests. `YamlPreview({ yaml, filename })` (Task 4) matches its sole consumer `ComponentBuilder` (Task 4) and the updated Plan 3 doc. `SELECT_SCHEMA` payload `{ schema, version }` unchanged and consistent.

**Cross-task note:** Tasks 2–4 depend on Task 1's reducer changes; execute in order. Tasks 2 and 4 both edit `ComponentBuilder.test.tsx` (Task 2 adds the category click; Task 4 updates the preview assertions) — non-overlapping edits.
