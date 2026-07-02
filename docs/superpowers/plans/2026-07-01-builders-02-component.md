# Builders — Plan 2: Component Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Component Builder — a 4-step wizard at `/components/new` that generates a Dapr Component YAML (copy/download), reachable via a "+ New component" button on the Components page.

**Architecture:** Builds on Plan 1's foundation (`lib/yaml-emit`, `lib/validation`, `lib/download`, `types/component`, `components/form/*`, `components/wizard/*`). State lives in a typed `useReducer` in the `ComponentBuilder` page; each step is a controlled child driven by that state. YAML is assembled from the reducer state and shown in a shared editable `YamlPreview` finalizer (also created here, reused by Plan 3). No component-emission stripping — each metadata item is assembled with only its populated key.

**Tech Stack:** React 19, TS, Vite, React Router v6, TanStack Query v5, Vitest + Testing Library. No new dependencies.

**Prereq:** Plan 1 (`docs/superpowers/plans/2026-07-01-builders-01-foundation.md`) merged/complete on this branch.
**Source spec:** `docs/superpowers/specs/2026-06-28-component-resiliency-builders-design.md`

## Global Constraints

- **No new dependencies.** No MUI/react-hook-form/Yup. Controlled components; vanilla CSS theme tokens.
- **Wizard buttons monochrome** (Plan 1's `.btn.mono` / `.btn.ghost`); never the green `.btn.primary`. Copy/Download also neutral/ghost.
- **`spec.type = `${schema.type}.${schema.name}`** (e.g. `state` + `redis` → `state.redis`); `spec.version` = the chosen schema `version` (e.g. `v1`).
- **Metadata array assembly (from Plan 1 review):** `recursivelyRemoveEmptyValues` is NOT used for component emission. Build `spec.metadata` by including, per active field: `{ name, secretKeyRef }` when "use secret" is on, else `{ name, value }` when the value is non-empty, else OMIT the item entirely. Never emit both `value` and `secretKeyRef`.
- **Reuse** existing `components/MetadataFieldInput.tsx` for field value controls, `lib/clipboard.ts` `copyText`, `lib/toast.tsx` `useToast`, `lib/yaml-highlight.tsx` `highlightYaml` (read-only views only), Plan 1 `components/form/*` and `components/wizard/*`.
- **Do NOT modify** the existing `hooks/useComponentCatalog.ts` (it powers the state-store connection dialog with synthetic-field behavior). Add a separate hook for the builder.
- **Tests:** Vitest + Testing Library, colocated. Run `npx tsc -b` before every commit. All `npm`/`npx` from `web/`.
- **On finish or cancel:** navigate to `/components`.

---

## File Structure

- Create `web/src/hooks/useComponentSchemas.ts` — all catalog schemas + grouping + active-fields helper.
- Create `web/src/components/YamlPreview.tsx` — shared editable finalizer (reused by Plan 3).
- Create `web/src/pages/component-builder/reducer.ts` — state, actions, reducer, `canContinue`, `assembleComponentSpec`.
- Create `web/src/pages/component-builder/StepType.tsx` — step 0.
- Create `web/src/pages/component-builder/StepAuth.tsx` — step 1.
- Create `web/src/pages/component-builder/StepConfigure.tsx` — step 2.
- Create `web/src/pages/component-builder/ComponentBuilder.tsx` — assembles wizard + preview + navigation.
- Modify `web/src/router.tsx` — add `components/new` route (before `components/:name`).
- Modify `web/src/pages/ResourceList.tsx` — add "+ New component" button (component kind only).

---

## Task 1: Catalog hook for the builder

**Files:**
- Create: `web/src/hooks/useComponentSchemas.ts`
- Create: `web/src/hooks/useComponentSchemas.test.tsx`

**Interfaces:**
- Produces:
  - `useComponentSchemas(): { schemas: ComponentMetadataSchema[]; byType: Record<string, ComponentMetadataSchema[]>; isLoading: boolean; isError: boolean }` — ALL components (no state-only filter), grouped by `type`.
  - `activeFields(schema: ComponentMetadataSchema, authProfile?: AuthenticationProfile): { required: MetadataField[]; optional: MetadataField[] }` — merges schema `metadata` with the selected auth profile's `metadata`; splits by `required`.
- Consumes: `lib/api.ts` `fetchJSON`; `types/metadata.ts` `MetadataBundle`, `ComponentMetadataSchema`, `MetadataField`, `AuthenticationProfile`.

- [ ] **Step 1: Write the failing test**

Create `web/src/hooks/useComponentSchemas.test.tsx`:
```tsx
import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { useComponentSchemas, activeFields } from './useComponentSchemas'
import type { ComponentMetadataSchema } from '../types/metadata'

const bundle = {
  schemaVersion: '1', date: '2026-01-01',
  components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
      metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' }] },
    { type: 'pubsub', name: 'redis', version: 'v1', title: 'Redis PubSub', status: 'stable', metadata: [] },
  ],
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryProvider client={makeQueryClient()}>{children}</QueryProvider>
}

describe('useComponentSchemas', () => {
  it('returns all schemas grouped by type (no state-only filter)', async () => {
    server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
    const { result } = renderHook(() => useComponentSchemas(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.schemas).toHaveLength(2)
    expect(Object.keys(result.current.byType).sort()).toEqual(['pubsub', 'state'])
    expect(result.current.byType.state[0].name).toBe('redis')
  })
})

describe('activeFields', () => {
  const schema: ComponentMetadataSchema = {
    type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
    metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' }],
  }
  it('splits required vs optional and merges auth-profile fields', () => {
    const { required, optional } = activeFields(schema, {
      title: 'AWS IAM', metadata: [{ name: 'accessKey', required: true, sensitive: true }],
    })
    expect(required.map((f) => f.name).sort()).toEqual(['accessKey', 'redisHost'])
    expect(optional.map((f) => f.name)).toEqual(['enableTLS'])
  })
  it('works with no auth profile', () => {
    const { required, optional } = activeFields(schema)
    expect(required.map((f) => f.name)).toEqual(['redisHost'])
    expect(optional.map((f) => f.name)).toEqual(['enableTLS'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- useComponentSchemas`
Expected: FAIL — cannot resolve `./useComponentSchemas`.

- [ ] **Step 3: Implement**

Create `web/src/hooks/useComponentSchemas.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import type { MetadataBundle, ComponentMetadataSchema, MetadataField, AuthenticationProfile } from '../types/metadata'

export function useComponentSchemas() {
  const query = useQuery<MetadataBundle>({
    queryKey: ['metadata', 'components'],
    queryFn: () => fetchJSON<MetadataBundle>('/metadata/components'),
    staleTime: 60 * 60 * 1000,
  })
  const schemas = query.data?.components ?? []
  const byType: Record<string, ComponentMetadataSchema[]> = {}
  for (const s of schemas) {
    ;(byType[s.type] ??= []).push(s)
  }
  return { schemas, byType, isLoading: query.isLoading, isError: query.isError }
}

/** Merge schema metadata with the chosen auth-profile metadata, split by required. */
export function activeFields(
  schema: ComponentMetadataSchema,
  authProfile?: AuthenticationProfile,
): { required: MetadataField[]; optional: MetadataField[] } {
  const all: MetadataField[] = [...(schema.metadata ?? []), ...(authProfile?.metadata ?? [])]
  const required = all.filter((f) => f.required)
  const optional = all.filter((f) => !f.required)
  return { required, optional }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- useComponentSchemas`
Expected: PASS.

- [ ] **Step 5: Type-check + full suite**

Run: `npx tsc -b` → 0. Then `npm test` → all green.

- [ ] **Step 6: Commit**

```bash
git add web/src/hooks/useComponentSchemas.ts web/src/hooks/useComponentSchemas.test.tsx
git commit -m "feat(web): add useComponentSchemas hook for the component builder"
```

---

## Task 2: Shared editable YAML finalizer

**Files:**
- Create: `web/src/components/YamlPreview.tsx`
- Create: `web/src/components/YamlPreview.test.tsx`

**Interfaces:**
- Produces: `YamlPreview({ yaml, filename, onEditedChange })` where
  - `yaml: string` — the generated YAML (regenerated by the parent when inputs change).
  - `filename: string` — download filename, e.g. `order.yaml`.
  - `onEditedChange?: (edited: boolean) => void` — fires `true` once the user manually edits the textarea, so the parent can disable Back (matches cloudgrid). "Reset to generated" restores and fires `false`.
  - Renders: a `<textarea className="inp code">` seeded with `yaml`; a "Reset to generated" button (`.btn.ghost`); Copy (`.btn.ghost`, uses `copyText` + `useToast`) and Download (`.btn.mono`, uses `downloadText`) acting on the CURRENT buffer.
- Consumes: `lib/clipboard.ts` `copyText`, `lib/toast.tsx` `useToast`, `lib/download.ts` `downloadText`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/YamlPreview.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { YamlPreview } from './YamlPreview'

describe('YamlPreview', () => {
  beforeEach(() => {
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it('seeds the textarea with the generated yaml', () => {
    render(<YamlPreview yaml={'a: 1\n'} filename="c.yaml" />)
    expect(screen.getByRole('textbox')).toHaveValue('a: 1\n')
  })

  it('reports edited=true on manual edit and edited=false on reset', () => {
    const onEditedChange = vi.fn()
    render(<YamlPreview yaml={'a: 1\n'} filename="c.yaml" onEditedChange={onEditedChange} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a: 2\n' } })
    expect(onEditedChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: /reset to generated/i }))
    expect(screen.getByRole('textbox')).toHaveValue('a: 1\n')
    expect(onEditedChange).toHaveBeenLastCalledWith(false)
  })

  it('download button uses the current buffer and the monochrome class', () => {
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
Expected: FAIL — cannot resolve `./YamlPreview`.

- [ ] **Step 3: Implement**

Create `web/src/components/YamlPreview.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import { downloadText } from '../lib/download'

interface YamlPreviewProps {
  yaml: string
  filename: string
  onEditedChange?: (edited: boolean) => void
}

export function YamlPreview({ yaml, filename, onEditedChange }: YamlPreviewProps) {
  const [buffer, setBuffer] = useState(yaml)
  const [edited, setEdited] = useState(false)
  const { toast, toastNode } = useToast()

  // Re-seed when the generated yaml changes AND the user hasn't manually edited.
  useEffect(() => {
    if (!edited) setBuffer(yaml)
  }, [yaml, edited])

  function onInput(value: string) {
    setBuffer(value)
    if (!edited) {
      setEdited(true)
      onEditedChange?.(true)
    }
  }

  function reset() {
    setBuffer(yaml)
    setEdited(false)
    onEditedChange?.(false)
  }

  return (
    <div>
      <textarea
        className="inp code"
        aria-label="Generated YAML"
        rows={16}
        value={buffer}
        onChange={(e) => onInput(e.target.value)}
      />
      <div className="stepnav" style={{ marginTop: 10 }}>
        <button type="button" className="btn ghost" onClick={reset}>Reset to generated</button>
        <div className="spacer" />
        <button
          type="button"
          className="btn ghost"
          onClick={() => { copyText(buffer); toast.show('Copied') }}
        >
          Copy
        </button>
        <button
          type="button"
          className="btn mono"
          onClick={() => downloadText(filename, buffer)}
        >
          Download
        </button>
      </div>
      {toastNode}
    </div>
  )
}
```
Note: confirm `useToast()`'s returned handle has a `show(msg)` method; if the API differs (e.g. `toast(msg)`), adapt the call. Check `web/src/lib/toast.tsx` before writing the test's expectations — the test above does not assert on the toast, so only the implementation call must match the real API.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- YamlPreview`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/YamlPreview.tsx web/src/components/YamlPreview.test.tsx
git commit -m "feat(web): add shared editable YamlPreview finalizer"
```

---

## Task 3: Component builder reducer + spec assembly

**Files:**
- Create: `web/src/pages/component-builder/reducer.ts`
- Create: `web/src/pages/component-builder/reducer.test.ts`

**Interfaces:**
- Produces:
  - `ComponentBuilderState` (below), `initialState()`, `reducer(state, action)`, `canContinue(state): boolean`, `assembleComponentSpec(state): ComponentSpec`.
  - Actions (discriminated union `Action`): `{type:'SELECT_SCHEMA', schema, version}`, `{type:'SET_AUTH_PROFILE', profile?: AuthenticationProfile}`, `{type:'SET_NAME', name}`, `{type:'SET_NAMESPACE', namespace}`, `{type:'SET_VALUE', field, value}`, `{type:'TOGGLE_SECRET', field, on}`, `{type:'SET_SECRET', field, ref}`, `{type:'ADD_OPTIONAL', field}`, `{type:'REMOVE_OPTIONAL', field}`, `{type:'NEXT'}`, `{type:'BACK'}`.
- Consumes: `types/component.ts` (`ComponentSpec`, `defaultComponentSpec`), `types/metadata.ts` (`ComponentMetadataSchema`, `AuthenticationProfile`), `lib/validation.ts` (`validateResourceName`), `hooks/useComponentSchemas.ts` (`activeFields`).

State shape:
```ts
export interface ComponentBuilderState {
  activeStep: number // 0..3
  schema?: ComponentMetadataSchema
  version: string
  authProfile?: AuthenticationProfile
  hasAuthProfiles: boolean // schema has >=1 auth profile
  name: string
  namespace: string
  values: Record<string, string>
  secretRefs: Record<string, { name: string; key: string }>
  useSecret: Record<string, boolean>
  optionalAdded: string[]
}
```

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/component-builder/reducer.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { initialState, reducer, canContinue, assembleComponentSpec } from './reducer'
import type { ComponentMetadataSchema } from '../../types/metadata'

const redis: ComponentMetadataSchema = {
  type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
  metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' }],
}

function withSchema() {
  return reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
}

describe('reducer / canContinue', () => {
  it('step 0 requires a schema', () => {
    expect(canContinue(initialState())).toBe(false)
    expect(canContinue(withSchema())).toBe(true)
  })

  it('SELECT_SCHEMA advances to step 1 and detects no auth profiles', () => {
    const s = withSchema()
    expect(s.activeStep).toBe(1)
    expect(s.hasAuthProfiles).toBe(false)
  })

  it('step 2 requires a valid name and all required fields filled', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' }) // 1 -> 2
    expect(s.activeStep).toBe(2)
    expect(canContinue(s)).toBe(false) // no name, redisHost empty
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'SET_VALUE', field: 'redisHost', value: 'localhost:6379' })
    expect(canContinue(s)).toBe(true)
  })

  it('a required field satisfied by a secret ref also passes the gate', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'TOGGLE_SECRET', field: 'redisHost', on: true })
    s = reducer(s, { type: 'SET_SECRET', field: 'redisHost', ref: { name: 'sec', key: 'host' } })
    expect(canContinue(s)).toBe(true)
  })
})

describe('assembleComponentSpec', () => {
  it('builds spec.type from type.name and emits only populated metadata keys', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'SET_VALUE', field: 'redisHost', value: 'localhost:6379' })
    const spec = assembleComponentSpec(s)
    expect(spec.spec.type).toBe('state.redis')
    expect(spec.spec.version).toBe('v1')
    expect(spec.metadata.name).toBe('order-store')
    expect(spec.spec.metadata).toEqual([{ name: 'redisHost', value: 'localhost:6379' }])
  })

  it('emits secretKeyRef (never value) when use-secret is on', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'TOGGLE_SECRET', field: 'redisHost', on: true })
    s = reducer(s, { type: 'SET_SECRET', field: 'redisHost', ref: { name: 'sec', key: 'host' } })
    const spec = assembleComponentSpec(s)
    expect(spec.spec.metadata).toEqual([{ name: 'redisHost', secretKeyRef: { name: 'sec', key: 'host' } }])
  })

  it('coerces number and bool field values', () => {
    const schema: ComponentMetadataSchema = {
      type: 'state', name: 'x', version: 'v1', title: 'X', status: 'stable',
      metadata: [{ name: 'port', type: 'number', required: true }, { name: 'tls', type: 'bool', required: true }],
    }
    let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema, version: 'v1' })
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'x1' })
    s = reducer(s, { type: 'SET_VALUE', field: 'port', value: '6379' })
    s = reducer(s, { type: 'SET_VALUE', field: 'tls', value: 'true' })
    const spec = assembleComponentSpec(s)
    expect(spec.spec.metadata).toEqual([{ name: 'port', value: 6379 }, { name: 'tls', value: true }])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- component-builder/reducer`
Expected: FAIL — cannot resolve `./reducer`.

- [ ] **Step 3: Implement**

Create `web/src/pages/component-builder/reducer.ts`:
```ts
import { defaultComponentSpec, type ComponentSpec } from '../../types/component'
import type { ComponentMetadataSchema, AuthenticationProfile, MetadataField } from '../../types/metadata'
import { validateResourceName } from '../../lib/validation'
import { activeFields } from '../../hooks/useComponentSchemas'

export interface ComponentBuilderState {
  activeStep: number
  schema?: ComponentMetadataSchema
  version: string
  authProfile?: AuthenticationProfile
  hasAuthProfiles: boolean
  name: string
  namespace: string
  values: Record<string, string>
  secretRefs: Record<string, { name: string; key: string }>
  useSecret: Record<string, boolean>
  optionalAdded: string[]
}

export type Action =
  | { type: 'SELECT_SCHEMA'; schema: ComponentMetadataSchema; version: string }
  | { type: 'SET_AUTH_PROFILE'; profile?: AuthenticationProfile }
  | { type: 'SET_NAME'; name: string }
  | { type: 'SET_NAMESPACE'; namespace: string }
  | { type: 'SET_VALUE'; field: string; value: string }
  | { type: 'TOGGLE_SECRET'; field: string; on: boolean }
  | { type: 'SET_SECRET'; field: string; ref: { name: string; key: string } }
  | { type: 'ADD_OPTIONAL'; field: string }
  | { type: 'REMOVE_OPTIONAL'; field: string }
  | { type: 'NEXT' }
  | { type: 'BACK' }

export function initialState(): ComponentBuilderState {
  return {
    activeStep: 0,
    version: '',
    hasAuthProfiles: false,
    name: '',
    namespace: 'default',
    values: {},
    secretRefs: {},
    useSecret: {},
    optionalAdded: [],
  }
}

export function reducer(state: ComponentBuilderState, action: Action): ComponentBuilderState {
  switch (action.type) {
    case 'SELECT_SCHEMA': {
      const hasAuthProfiles = (action.schema.authenticationProfiles?.length ?? 0) > 0
      return { ...state, schema: action.schema, version: action.version, hasAuthProfiles, activeStep: 1 }
    }
    case 'SET_AUTH_PROFILE':
      return { ...state, authProfile: action.profile }
    case 'SET_NAME':
      return { ...state, name: action.name }
    case 'SET_NAMESPACE':
      return { ...state, namespace: action.namespace }
    case 'SET_VALUE':
      return { ...state, values: { ...state.values, [action.field]: action.value } }
    case 'TOGGLE_SECRET':
      return { ...state, useSecret: { ...state.useSecret, [action.field]: action.on } }
    case 'SET_SECRET':
      return { ...state, secretRefs: { ...state.secretRefs, [action.field]: action.ref } }
    case 'ADD_OPTIONAL':
      return state.optionalAdded.includes(action.field)
        ? state
        : { ...state, optionalAdded: [...state.optionalAdded, action.field] }
    case 'REMOVE_OPTIONAL':
      return { ...state, optionalAdded: state.optionalAdded.filter((f) => f !== action.field) }
    case 'NEXT':
      return { ...state, activeStep: state.activeStep + 1 }
    case 'BACK':
      return { ...state, activeStep: Math.max(0, state.activeStep - 1) }
    default:
      return state
  }
}

// The fields shown on the Configure step: all required + any optional the user added.
function configureFields(state: ComponentBuilderState): MetadataField[] {
  if (!state.schema) return []
  const { required, optional } = activeFields(state.schema, state.authProfile)
  const added = optional.filter((f) => state.optionalAdded.includes(f.name))
  return [...required, ...added]
}

function fieldSatisfied(state: ComponentBuilderState, f: MetadataField): boolean {
  if (state.useSecret[f.name]) {
    const ref = state.secretRefs[f.name]
    return !!ref && ref.name.trim() !== '' && ref.key.trim() !== ''
  }
  return (state.values[f.name] ?? '').trim() !== ''
}

export function canContinue(state: ComponentBuilderState): boolean {
  switch (state.activeStep) {
    case 0:
      return !!state.schema && state.version !== ''
    case 1:
      return true // auth profile optional
    case 2: {
      if (validateResourceName(state.name) !== null) return false
      const required = configureFields(state).filter((f) => f.required)
      return required.every((f) => fieldSatisfied(state, f))
    }
    default:
      return true
  }
}

export function assembleComponentSpec(state: ComponentBuilderState): ComponentSpec {
  const spec = defaultComponentSpec()
  spec.metadata.name = state.name
  if (state.namespace.trim() !== '') spec.metadata.namespace = state.namespace
  spec.spec.type = state.schema ? `${state.schema.type}.${state.schema.name}` : ''
  spec.spec.version = state.version
  const byName = new Map(configureFields(state).map((f) => [f.name, f]))
  spec.spec.metadata = []
  for (const [name, field] of byName) {
    if (state.useSecret[name]) {
      const ref = state.secretRefs[name]
      if (ref && ref.name && ref.key) spec.spec.metadata.push({ name, secretKeyRef: ref })
      continue
    }
    const raw = (state.values[name] ?? '').trim()
    if (raw === '') continue
    let value: string | number | boolean = raw
    if (field.type === 'number') value = Number(raw)
    else if (field.type === 'bool') value = raw === 'true'
    spec.spec.metadata.push({ name, value })
  }
  return spec
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- component-builder/reducer`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/component-builder/reducer.ts web/src/pages/component-builder/reducer.test.ts
git commit -m "feat(web): add component builder reducer + spec assembly"
```

---

## Task 4: Step 0 — Type picker

**Files:**
- Create: `web/src/pages/component-builder/StepType.tsx`
- Create: `web/src/pages/component-builder/StepType.test.tsx`

**Interfaces:**
- Produces: `StepType({ state, dispatch })` where `state: ComponentBuilderState`, `dispatch: (a: Action) => void`. Renders a search box + a list of schemas grouped by type (from `useComponentSchemas`); clicking a schema dispatches `SELECT_SCHEMA` with that schema and its `version`. Uses `.md`/`.complist`/`.ci`/`.ci.sel` classes (master-detail list styling that already exists).
- Consumes: `useComponentSchemas`, reducer `Action`/`ComponentBuilderState`.

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/component-builder/StepType.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { QueryProvider, makeQueryClient } from '../../lib/query'
import { StepType } from './StepType'
import { initialState } from './reducer'

const bundle = {
  schemaVersion: '1', date: '2026-01-01',
  components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable', metadata: [] },
    { type: 'pubsub', name: 'kafka', version: 'v1', title: 'Apache Kafka', status: 'stable', metadata: [] },
  ],
}

function renderStep(dispatch = vi.fn()) {
  server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
  return render(
    <QueryProvider client={makeQueryClient()}>
      <StepType state={initialState()} dispatch={dispatch} />
    </QueryProvider>,
  )
}

describe('StepType', () => {
  it('lists schemas and filters by search text', async () => {
    renderStep()
    await screen.findByText('Redis')
    expect(screen.getByText('Apache Kafka')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'kafka' } })
    expect(screen.queryByText('Redis')).not.toBeInTheDocument()
    expect(screen.getByText('Apache Kafka')).toBeInTheDocument()
  })

  it('dispatches SELECT_SCHEMA with schema + version on click', async () => {
    const dispatch = vi.fn()
    renderStep(dispatch)
    fireEvent.click(await screen.findByText('Redis'))
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SELECT_SCHEMA', version: 'v1' }),
    )
    expect(dispatch.mock.calls[0][0].schema.name).toBe('redis')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- component-builder/StepType`
Expected: FAIL — cannot resolve `./StepType`.

- [ ] **Step 3: Implement**

Create `web/src/pages/component-builder/StepType.tsx`:
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

  const query = q.trim().toLowerCase()
  const types = Object.keys(byType).sort()

  return (
    <div>
      <div className="search" style={{ marginBottom: 12 }}>
        <input
          type="search"
          aria-label="Search components"
          placeholder="Search components…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="complist card">
        {types.map((type) => {
          const matches = byType[type].filter(
            (s) => !query || s.title.toLowerCase().includes(query) || s.name.toLowerCase().includes(query),
          )
          if (matches.length === 0) return null
          return (
            <div key={type} className="sbsection">
              <div className="sbtitle">{type}</div>
              {matches.map((s) => {
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
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- component-builder/StepType`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/component-builder/StepType.tsx web/src/pages/component-builder/StepType.test.tsx
git commit -m "feat(web): add component builder Step 0 (type picker)"
```

---

## Task 5: Step 1 — Auth profile picker

**Files:**
- Create: `web/src/pages/component-builder/StepAuth.tsx`
- Create: `web/src/pages/component-builder/StepAuth.test.tsx`

**Interfaces:**
- Produces: `StepAuth({ state, dispatch })`. If `state.schema` has no `authenticationProfiles`, renders a "This component has no authentication profiles — continue." message. Otherwise renders a `SelectInput` of profile titles; choosing one dispatches `SET_AUTH_PROFILE` with the matching profile; choosing the blank option dispatches `SET_AUTH_PROFILE` with `undefined`.
- Consumes: `components/form` `Field`, `SelectInput`; reducer types.

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/component-builder/StepAuth.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StepAuth } from './StepAuth'
import { initialState, reducer } from './reducer'
import type { ComponentMetadataSchema } from '../../types/metadata'

const withProfiles: ComponentMetadataSchema = {
  type: 'bindings', name: 'aws.s3', version: 'v1', title: 'AWS S3', status: 'stable', metadata: [],
  authenticationProfiles: [
    { title: 'AWS IAM', metadata: [{ name: 'accessKey', required: true }] },
    { title: 'AWS STS', metadata: [{ name: 'sessionToken', required: true }] },
  ],
}

function stateWith(schema: ComponentMetadataSchema) {
  return reducer(initialState(), { type: 'SELECT_SCHEMA', schema, version: 'v1' })
}

describe('StepAuth', () => {
  it('shows a no-profiles message when the schema has none', () => {
    const schema: ComponentMetadataSchema = { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable', metadata: [] }
    render(<StepAuth state={stateWith(schema)} dispatch={vi.fn()} />)
    expect(screen.getByText(/no authentication profiles/i)).toBeInTheDocument()
  })

  it('dispatches SET_AUTH_PROFILE with the chosen profile', () => {
    const dispatch = vi.fn()
    render(<StepAuth state={stateWith(withProfiles)} dispatch={dispatch} />)
    fireEvent.change(screen.getByLabelText(/authentication profile/i), { target: { value: 'AWS STS' } })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_AUTH_PROFILE', profile: expect.objectContaining({ title: 'AWS STS' }) }),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- component-builder/StepAuth`
Expected: FAIL — cannot resolve `./StepAuth`.

- [ ] **Step 3: Implement**

Create `web/src/pages/component-builder/StepAuth.tsx`:
```tsx
import { Field, SelectInput } from '../../components/form'
import type { Action, ComponentBuilderState } from './reducer'

interface Props {
  state: ComponentBuilderState
  dispatch: (a: Action) => void
}

export function StepAuth({ state, dispatch }: Props) {
  const profiles = state.schema?.authenticationProfiles ?? []
  if (profiles.length === 0) {
    return <p className="muted">This component has no authentication profiles — continue.</p>
  }
  return (
    <Field label="Authentication profile" htmlFor="auth-profile">
      <SelectInput
        id="auth-profile"
        aria-label="Authentication profile"
        value={state.authProfile?.title ?? ''}
        options={profiles.map((p) => ({ label: p.title, value: p.title }))}
        onChange={(title) =>
          dispatch({ type: 'SET_AUTH_PROFILE', profile: profiles.find((p) => p.title === title) })
        }
      />
    </Field>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- component-builder/StepAuth`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/component-builder/StepAuth.tsx web/src/pages/component-builder/StepAuth.test.tsx
git commit -m "feat(web): add component builder Step 1 (auth profile)"
```

---

## Task 6: Step 2 — Configure (name + metadata editor)

**Files:**
- Create: `web/src/pages/component-builder/StepConfigure.tsx`
- Create: `web/src/pages/component-builder/StepConfigure.test.tsx`

**Interfaces:**
- Produces: `StepConfigure({ state, dispatch })`. Renders: a `Field`+`TextInput` for `name` (with `validateResourceName` error shown), an optional `namespace` `TextInput`; the required + added-optional fields, each row = `Field` (label, `required`, description) + either a "use secret" `Toggle` → two `TextInput`s (secret name + key) OR the value control via reused `MetadataFieldInput`; and a "+ add optional field" `SelectInput` listing not-yet-added optional fields (dispatch `ADD_OPTIONAL`).
- Consumes: `components/form` (`Field`, `TextInput`, `Toggle`, `SelectInput`), `components/MetadataFieldInput`, `lib/validation` (`validateResourceName`), `hooks/useComponentSchemas` (`activeFields`), reducer types.

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/component-builder/StepConfigure.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StepConfigure } from './StepConfigure'
import { initialState, reducer } from './reducer'
import type { ComponentMetadataSchema } from '../../types/metadata'

const redis: ComponentMetadataSchema = {
  type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
  metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' }],
}
function configureState() {
  let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
  s = reducer(s, { type: 'NEXT' }) // -> step 2
  return s
}

describe('StepConfigure', () => {
  it('dispatches SET_NAME and shows a validation error for a bad name', () => {
    const dispatch = vi.fn()
    render(<StepConfigure state={configureState()} dispatch={dispatch} />)
    const name = screen.getByLabelText(/^name/i)
    fireEvent.change(name, { target: { value: 'Bad Name' } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_NAME', name: 'Bad Name' })
  })

  it('renders the required field and dispatches SET_VALUE', () => {
    const dispatch = vi.fn()
    render(<StepConfigure state={configureState()} dispatch={dispatch} />)
    fireEvent.change(screen.getByLabelText('redisHost'), { target: { value: 'localhost:6379' } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_VALUE', field: 'redisHost', value: 'localhost:6379' })
  })

  it('toggling "use secret" for a field dispatches TOGGLE_SECRET', () => {
    const dispatch = vi.fn()
    render(<StepConfigure state={configureState()} dispatch={dispatch} />)
    fireEvent.click(screen.getByLabelText(/use secret for redisHost/i))
    expect(dispatch).toHaveBeenCalledWith({ type: 'TOGGLE_SECRET', field: 'redisHost', on: true })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- component-builder/StepConfigure`
Expected: FAIL — cannot resolve `./StepConfigure`.

- [ ] **Step 3: Implement**

Create `web/src/pages/component-builder/StepConfigure.tsx`:
```tsx
import { Field, TextInput, Toggle, SelectInput } from '../../components/form'
import { MetadataFieldInput } from '../../components/MetadataFieldInput'
import { validateResourceName } from '../../lib/validation'
import { activeFields } from '../../hooks/useComponentSchemas'
import type { Action, ComponentBuilderState } from './reducer'
import type { MetadataField } from '../../types/metadata'

interface Props {
  state: ComponentBuilderState
  dispatch: (a: Action) => void
}

export function StepConfigure({ state, dispatch }: Props) {
  if (!state.schema) return null
  const { required, optional } = activeFields(state.schema, state.authProfile)
  const addedOptional = optional.filter((f) => state.optionalAdded.includes(f.name))
  const shown: MetadataField[] = [...required, ...addedOptional]
  const notAdded = optional.filter((f) => !state.optionalAdded.includes(f.name))
  const nameError = state.name === '' ? null : validateResourceName(state.name)

  return (
    <div>
      <Field label="Name" htmlFor="c-name" required error={nameError}>
        <TextInput id="c-name" aria-label="Name" value={state.name} onChange={(v) => dispatch({ type: 'SET_NAME', name: v })} />
      </Field>
      <Field label="Namespace" htmlFor="c-ns">
        <TextInput id="c-ns" aria-label="Namespace" value={state.namespace} onChange={(v) => dispatch({ type: 'SET_NAMESPACE', namespace: v })} />
      </Field>

      <div className="sec-title">Metadata</div>
      {shown.map((f) => {
        const useSecret = !!state.useSecret[f.name]
        const ref = state.secretRefs[f.name] ?? { name: '', key: '' }
        return (
          <Field key={f.name} label={f.name} required={f.required} error={undefined}>
            {f.description && <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>{f.description}</div>}
            <Toggle
              label={`Use secret for ${f.name}`}
              checked={useSecret}
              onChange={(on) => dispatch({ type: 'TOGGLE_SECRET', field: f.name, on })}
            />
            {useSecret ? (
              <div className="field-row">
                <TextInput aria-label={`${f.name} secret name`} placeholder="secret name" value={ref.name}
                  onChange={(v) => dispatch({ type: 'SET_SECRET', field: f.name, ref: { ...ref, name: v } })} />
                <TextInput aria-label={`${f.name} secret key`} placeholder="secret key" value={ref.key}
                  onChange={(v) => dispatch({ type: 'SET_SECRET', field: f.name, ref: { ...ref, key: v } })} />
              </div>
            ) : (
              <MetadataFieldInput field={f} value={state.values[f.name] ?? ''} onChange={(v) => dispatch({ type: 'SET_VALUE', field: f.name, value: v })} />
            )}
          </Field>
        )
      })}

      {notAdded.length > 0 && (
        <Field label="Add optional field" htmlFor="add-opt">
          <SelectInput
            id="add-opt"
            aria-label="Add optional field"
            value=""
            options={notAdded.map((f) => ({ label: f.name, value: f.name }))}
            onChange={(field) => field && dispatch({ type: 'ADD_OPTIONAL', field })}
          />
        </Field>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- component-builder/StepConfigure`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/component-builder/StepConfigure.tsx web/src/pages/component-builder/StepConfigure.test.tsx
git commit -m "feat(web): add component builder Step 2 (configure)"
```

---

## Task 7: Assemble ComponentBuilder + route + entry button

**Files:**
- Create: `web/src/pages/component-builder/ComponentBuilder.tsx`
- Create: `web/src/pages/component-builder/ComponentBuilder.test.tsx`
- Modify: `web/src/router.tsx`
- Modify: `web/src/pages/ResourceList.tsx`

**Interfaces:**
- Consumes: `components/wizard` (`Wizard`, `WizardStep`), `components/YamlPreview`, reducer (`initialState`, `reducer`, `canContinue`, `assembleComponentSpec`), `lib/yaml-emit` (`dumpYaml`), the three step components, `react-router-dom` (`useNavigate`).
- Produces: `ComponentBuilder` page (default export not required; named export `ComponentBuilder`). Route `/components/new`. A `+ New component` button on the Components `ResourceList`.

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/component-builder/ComponentBuilder.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../../test/setup'
import { QueryProvider, makeQueryClient } from '../../lib/query'
import { ComponentBuilder } from './ComponentBuilder'

const bundle = {
  schemaVersion: '1', date: '2026-01-01',
  components: [{ type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
    metadata: [{ name: 'redisHost', required: true }] }],
}

function renderBuilder() {
  server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
  const router = createMemoryRouter(
    [{ path: '/components/new', element: <ComponentBuilder /> }, { path: '/components', element: <div>components list</div> }],
    { initialEntries: ['/components/new'], future: { v7_relativeSplatPath: true } },
  )
  return render(<QueryProvider client={makeQueryClient()}><RouterProvider router={router} future={{ v7_startTransition: true }} /></QueryProvider>)
}

describe('ComponentBuilder', () => {
  it('walks type → (auth) → configure → preview and shows generated YAML', async () => {
    renderBuilder()
    fireEvent.click(await screen.findByText('Redis')) // step 0 -> 1
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // step 1 -> 2 (no profiles)
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'order-store' } })
    fireEvent.change(screen.getByLabelText('redisHost'), { target: { value: 'localhost:6379' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // step 2 -> 3
    await waitFor(() => expect(screen.getByRole('textbox', { name: /generated yaml/i })).toHaveValue(
      expect.stringContaining('type: state.redis'),
    ))
    expect(screen.getByRole('textbox', { name: /generated yaml/i })).toHaveValue(expect.stringContaining('name: order-store'))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- component-builder/ComponentBuilder`
Expected: FAIL — cannot resolve `./ComponentBuilder`.

- [ ] **Step 3: Implement the page**

Create `web/src/pages/component-builder/ComponentBuilder.tsx`:
```tsx
import { useMemo, useReducer, useState } from 'react'
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
  const [previewEdited, setPreviewEdited] = useState(false)

  const yaml = useMemo(
    () => (state.activeStep === 3 ? dumpYaml(assembleComponentSpec(state)) : ''),
    [state],
  )

  const steps: WizardStep[] = [
    { label: 'Type', content: <StepType state={state} dispatch={dispatch} /> },
    { label: 'Auth', content: <StepAuth state={state} dispatch={dispatch} /> },
    { label: 'Configure', content: <StepConfigure state={state} dispatch={dispatch} /> },
    {
      label: 'Preview',
      content: (
        <YamlPreview yaml={yaml} filename={`${state.name || 'component'}.yaml`} onEditedChange={setPreviewEdited} />
      ),
    },
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
      <div className="card" style={{ padding: 18 }}>
        <Wizard
          steps={steps}
          activeStep={state.activeStep}
          canContinue={state.activeStep === 3 ? !previewEdited : canContinue(state)}
          onBack={() => dispatch({ type: 'BACK' })}
          onContinue={() => dispatch({ type: 'NEXT' })}
          onFinish={() => navigate('/components')}
        />
      </div>
    </div>
  )
}
```
Note: on the last step, `canContinue` is gated on `!previewEdited` so Finish is disabled once the user has manually edited the YAML (matches cloudgrid's "Back disabled after edit" intent; here it guards Finish so a hand-edited buffer isn't silently discarded — Download/Copy still act on the buffer). If product prefers Finish always enabled, drop that clause.

- [ ] **Step 4: Add the route**

Modify `web/src/router.tsx`: import `ComponentBuilder` and add the static route BEFORE `components/:name`:
```tsx
import { ComponentBuilder } from './pages/component-builder/ComponentBuilder'
// ...
      { path: 'components/new', element: <ComponentBuilder /> },
      { path: 'components', element: <ResourceList kind="component" /> },
      { path: 'components/:name', element: <ResourceList kind="component" /> },
```
(Place `components/new` before `components/:name`.)

- [ ] **Step 5: Add the "+ New component" button on the Components page**

Modify `web/src/pages/ResourceList.tsx`: import `Link` from `react-router-dom` (if not already) and render a button in the `.phead` for the component kind. In each of the three `.phead` blocks (loading, empty, populated), change the header to include the action for `kind === 'component'`:
```tsx
        <div className="phead">
          <div>
            <h1>{title}</h1>
            <div className="sub">{sub}</div>
          </div>
          {kind === 'component' && (
            <Link className="btn mono" to="/components/new">+ New component</Link>
          )}
        </div>
```
Apply this to all three `.phead` occurrences so the button is present in every state. (`.btn.mono` is defined by Plan 1; the button is monochrome, consistent with the builder.)

- [ ] **Step 6: Run the builder test + full suite**

Run: `npm test -- component-builder/ComponentBuilder` → PASS.
Run: `npm test` → all green (ResourceList tests still pass; if a ResourceList test asserts exact `.phead` contents, update it to allow the new button — prefer role/text queries).

- [ ] **Step 7: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/component-builder/ComponentBuilder.tsx web/src/pages/component-builder/ComponentBuilder.test.tsx web/src/router.tsx web/src/pages/ResourceList.tsx
git commit -m "feat(web): wire Component Builder route + New component button"
```

---

## Self-Review

**Spec coverage (Component Builder):**
- Catalog fetch generalized (all types, auth profiles) → Task 1 (new hook; existing `useComponentCatalog` untouched, documented). ✓
- 4-step flow: Type → Auth (conditional) → Configure → Preview → Tasks 4, 5, 6, 7. ✓
- Auth profile seeds required fields → `activeFields` merges profile metadata (Task 1) consumed by reducer/Configure. ✓
- Metadata editor: value OR secret toggle; field-type control via `MetadataFieldInput`; validation gates Continue → Task 6 + reducer `canContinue`/`fieldSatisfied` (Task 3). ✓
- Editable YAML finalizer, Copy + Download → Task 2 (`YamlPreview`), used in Task 7. ✓
- `spec.type = type.name`, version from schema; only-populated-key metadata assembly (no stripper) → Task 3 `assembleComponentSpec`. ✓
- Routing `/components/new` (before `:name`) + "+ New component" button → Task 7. ✓
- Monochrome buttons throughout (`.btn.mono`/`.btn.ghost`) → Tasks 2, 7. ✓
- Dropped connected-mode "Access & Scopes" step (scopes free-text only; v1 omits scopes UI entirely) → not built. ✓
- Finish/Cancel → `/components` → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code + commands with expected results. Two explicit "verify the real API" notes (Task 2 `useToast` shape; Task 7 ResourceList test adjustment) are verification steps, not placeholders.

**Type consistency:** `ComponentBuilderState`/`Action` (Task 3) are consumed identically by Steps (Tasks 4–6) and the page (Task 7). `useComponentSchemas`/`activeFields` (Task 1) are used by StepType, reducer, StepConfigure with the same signatures. `assembleComponentSpec`→`dumpYaml`→`YamlPreview` chain is consistent. `SELECT_SCHEMA` carries `{schema, version}` everywhere.

**Open verification note for implementers:** Task 2 must confirm `useToast()`'s handle API (`toast.show(...)` vs `toast(...)`) against `web/src/lib/toast.tsx` and adapt the call; the test does not depend on it. Task 7 Step 5 may require updating a ResourceList test if it asserts exact header contents.
