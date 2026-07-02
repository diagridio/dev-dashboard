# Builders — Plan 3: Resiliency Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Resiliency Builder — a 4-step wizard at `/resiliency/new` that generates a Dapr Resiliency YAML (copy/download) — plus a "Resiliency" nav item and a create-only `/resiliency` landing page.

**Architecture:** Builds on Plan 1 (`lib/yaml-emit`, `lib/validation`, `lib/download`, `types/resiliency`, `components/form/*`, `components/wizard/*`, `components/Modal`) and reuses Plan 2's `components/YamlPreview`. State is a typed `useReducer` holding a `DaprResiliency` config; policies and targets are added/edited via `Modal` dialogs and rendered as named lists. Preview runs `recursivelyRemoveEmptyValues` over `spec` before emitting (per spec).

**Tech Stack:** React 19, TS, Vite, React Router v6, Vitest + Testing Library. No new dependencies.

**Prereqs:** Plan 1 complete; Plan 2 complete (provides `components/YamlPreview.tsx`).
**Source spec:** `docs/superpowers/specs/2026-06-28-component-resiliency-builders-design.md`

## Global Constraints

- **No new dependencies.** No MUI/react-hook-form/Yup. Controlled components; vanilla CSS theme tokens.
- **Wizard/dialog buttons use the transparent `.btn.ghost` style** (disabled = light border + faint text); never green `.btn.primary` or filled `.btn.mono`.
- **`grpcStatusCodes`** spelling (matches `types/resiliency.ts`; cloudgrid's `grcpStatusCodes` typo is NOT used).
- **Emit rule:** clean ONLY `spec` with `recursivelyRemoveEmptyValues` before `dumpYaml`; assemble the emit object with `metadata.name` (+ `namespace` only if non-empty); omit empty `scopes`.
- **Policy/target naming:** sequential defaults `timeout1`/`retry1`/`circuitBreaker1` etc. (count of existing + 1), editable in the dialog.
- **v1 scope (YAGNI, documented):** DROP cloudgrid's connected-mode `ResiliencyAccess` (cluster/namespace/scope pickers) — step 0 is just the name. DROP the read-only "DaprBuiltIn default-policy overrides" table on the Targets step (advanced; future enhancement). Targets step gates on **≥1 target of any type**.
- **Reuse** `components/Modal.tsx`, Plan 1 `components/form/*` + `components/wizard/*`, Plan 2 `components/YamlPreview.tsx`, `lib/validation`, `lib/yaml-emit`.
- **Tests:** Vitest + Testing Library, colocated. Run `npx tsc -b` before every commit. All `npm`/`npx` from `web/`.
- **On finish or cancel:** navigate to `/resiliency`.

---

## File Structure

- Create `web/src/pages/resiliency-builder/reducer.ts` — state, actions, reducer, gating, name-gen, `assembleResiliency`.
- Create `web/src/pages/resiliency-builder/NamedList.tsx` — reusable "named entries + Add/Remove" list.
- Create `web/src/pages/resiliency-builder/policyDialogs.tsx` — `TimeoutDialog`, `RetryDialog`, `CircuitBreakerDialog`.
- Create `web/src/pages/resiliency-builder/targetDialogs.tsx` — `AppTargetDialog`, `ActorTargetDialog`, `ComponentTargetDialog`.
- Create `web/src/pages/resiliency-builder/StepGeneral.tsx`, `StepPolicies.tsx`, `StepTargets.tsx`.
- Create `web/src/pages/resiliency-builder/ResiliencyBuilder.tsx` — assembles wizard + preview.
- Create `web/src/pages/Resiliency.tsx` — create-only landing page.
- Modify `web/src/router.tsx` — add `resiliency` and `resiliency/new` routes.
- Modify `web/src/components/TopNav.tsx` — add the `Resiliency` nav item.

---

## Task 1: Resiliency reducer + assembly + gating

**Files:**
- Create: `web/src/pages/resiliency-builder/reducer.ts`
- Create: `web/src/pages/resiliency-builder/reducer.test.ts`

**Interfaces:**
- Produces:
  - `ResiliencyState = { config: DaprResiliency; activeStep: number }`, `initialState()`, `reducer(state, action)`, `canContinue(state): boolean`, `assembleResiliency(config: DaprResiliency): Record<string, unknown>`, and `nextName(prefix: string, existing: Record<string, unknown>): string`.
  - Actions (`Action`): `{type:'SET_NAME',name}`, `{type:'SET_NAMESPACE',namespace}`, `{type:'UPSERT_TIMEOUT',name,duration}`, `{type:'REMOVE_TIMEOUT',name}`, `{type:'UPSERT_RETRY',name,policy}`, `{type:'REMOVE_RETRY',name}`, `{type:'UPSERT_CB',name,policy}`, `{type:'REMOVE_CB',name}`, `{type:'UPSERT_APP',name,target}`, `{type:'REMOVE_APP',name}`, `{type:'UPSERT_ACTOR',name,target}`, `{type:'REMOVE_ACTOR',name}`, `{type:'UPSERT_COMPONENT',name,target}`, `{type:'REMOVE_COMPONENT',name}`, `{type:'NEXT'}`, `{type:'BACK'}`.
- Consumes: `types/resiliency.ts` (all types + `defaultResiliencyConfig`), `lib/validation.ts` (`validateResourceName`), `lib/yaml-emit.ts` (`recursivelyRemoveEmptyValues`).

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/resiliency-builder/reducer.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { initialState, reducer, canContinue, assembleResiliency, nextName } from './reducer'

describe('nextName', () => {
  it('produces sequential names by count of existing keys', () => {
    expect(nextName('retry', {})).toBe('retry1')
    expect(nextName('retry', { retry1: {}, retry2: {} })).toBe('retry3')
  })
})

describe('canContinue', () => {
  it('step 0 needs a valid name', () => {
    let s = initialState()
    expect(canContinue(s)).toBe(false)
    s = reducer(s, { type: 'SET_NAME', name: 'my-resiliency' })
    expect(canContinue(s)).toBe(true)
  })
  it('step 1 needs at least one policy of any kind', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'NEXT' }) // -> 1
    expect(canContinue(s)).toBe(false)
    s = reducer(s, { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    expect(canContinue(s)).toBe(true)
  })
  it('step 2 needs at least one target of any kind', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    s = reducer(s, { type: 'NEXT' }) // 0->1
    s = reducer(s, { type: 'NEXT' }) // 1->2
    expect(canContinue(s)).toBe(false)
    s = reducer(s, { type: 'UPSERT_APP', name: 'orders', target: { timeout: 'timeout1' } })
    expect(canContinue(s)).toBe(true)
  })
})

describe('reducer upserts/removes', () => {
  it('adds and removes a retry policy', () => {
    let s = reducer(initialState(), { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s', maxRetries: 3 } })
    expect(s.config.spec.policies.retries.retry1.duration).toBe('5s')
    s = reducer(s, { type: 'REMOVE_RETRY', name: 'retry1' })
    expect(s.config.spec.policies.retries.retry1).toBeUndefined()
  })
})

describe('assembleResiliency', () => {
  it('cleans spec, keeps name, omits empty namespace/scopes', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s', maxRetries: 3, maxInterval: '', matching: { httpStatusCodes: '', grpcStatusCodes: '' } } })
    const out = assembleResiliency(s.config) as any
    expect(out.metadata).toEqual({ name: 'r' }) // no empty namespace
    expect(out.scopes).toBeUndefined()
    // empty maxInterval + empty matching pruned by recursivelyRemoveEmptyValues:
    expect(out.spec.policies.retries.retry1).toEqual({ policy: 'constant', duration: '5s', maxRetries: 3 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- resiliency-builder/reducer`
Expected: FAIL — cannot resolve `./reducer`.

- [ ] **Step 3: Implement**

Create `web/src/pages/resiliency-builder/reducer.ts`:
```ts
import {
  defaultResiliencyConfig, type DaprResiliency, type RetryPolicy, type CircuitBreakerPolicy,
  type AppTarget, type ActorTarget, type ComponentTarget,
} from '../../types/resiliency'
import { validateResourceName } from '../../lib/validation'
import { recursivelyRemoveEmptyValues } from '../../lib/yaml-emit'

export interface ResiliencyState {
  config: DaprResiliency
  activeStep: number
}

export type Action =
  | { type: 'SET_NAME'; name: string }
  | { type: 'SET_NAMESPACE'; namespace: string }
  | { type: 'UPSERT_TIMEOUT'; name: string; duration: string }
  | { type: 'REMOVE_TIMEOUT'; name: string }
  | { type: 'UPSERT_RETRY'; name: string; policy: RetryPolicy }
  | { type: 'REMOVE_RETRY'; name: string }
  | { type: 'UPSERT_CB'; name: string; policy: CircuitBreakerPolicy }
  | { type: 'REMOVE_CB'; name: string }
  | { type: 'UPSERT_APP'; name: string; target: AppTarget }
  | { type: 'REMOVE_APP'; name: string }
  | { type: 'UPSERT_ACTOR'; name: string; target: ActorTarget }
  | { type: 'REMOVE_ACTOR'; name: string }
  | { type: 'UPSERT_COMPONENT'; name: string; target: ComponentTarget }
  | { type: 'REMOVE_COMPONENT'; name: string }
  | { type: 'NEXT' }
  | { type: 'BACK' }

export function initialState(): ResiliencyState {
  return { config: defaultResiliencyConfig(), activeStep: 0 }
}

/** `retry1`, `retry2`, ... based on the count of existing keys (matches cloudgrid). */
export function nextName(prefix: string, existing: Record<string, unknown>): string {
  return `${prefix}${Object.keys(existing).length + 1}`
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map }
  delete next[key]
  return next
}

export function reducer(state: ResiliencyState, action: Action): ResiliencyState {
  const cfg = state.config
  const pol = cfg.spec.policies
  const tgt = cfg.spec.targets
  const set = (patch: Partial<DaprResiliency['spec']>): ResiliencyState => ({
    ...state,
    config: { ...cfg, spec: { ...cfg.spec, ...patch } },
  })
  switch (action.type) {
    case 'SET_NAME':
      return { ...state, config: { ...cfg, metadata: { ...cfg.metadata, name: action.name } } }
    case 'SET_NAMESPACE':
      return { ...state, config: { ...cfg, metadata: { ...cfg.metadata, namespace: action.namespace } } }
    case 'UPSERT_TIMEOUT':
      return set({ policies: { ...pol, timeouts: { ...pol.timeouts, [action.name]: action.duration } } })
    case 'REMOVE_TIMEOUT':
      return set({ policies: { ...pol, timeouts: withoutKey(pol.timeouts, action.name) } })
    case 'UPSERT_RETRY':
      return set({ policies: { ...pol, retries: { ...pol.retries, [action.name]: action.policy } } })
    case 'REMOVE_RETRY':
      return set({ policies: { ...pol, retries: withoutKey(pol.retries, action.name) } })
    case 'UPSERT_CB':
      return set({ policies: { ...pol, circuitBreakers: { ...pol.circuitBreakers, [action.name]: action.policy } } })
    case 'REMOVE_CB':
      return set({ policies: { ...pol, circuitBreakers: withoutKey(pol.circuitBreakers, action.name) } })
    case 'UPSERT_APP':
      return set({ targets: { ...tgt, apps: { ...(tgt.apps ?? {}), [action.name]: action.target } } })
    case 'REMOVE_APP':
      return set({ targets: { ...tgt, apps: withoutKey(tgt.apps ?? {}, action.name) } })
    case 'UPSERT_ACTOR':
      return set({ targets: { ...tgt, actors: { ...(tgt.actors ?? {}), [action.name]: action.target } } })
    case 'REMOVE_ACTOR':
      return set({ targets: { ...tgt, actors: withoutKey(tgt.actors ?? {}, action.name) } })
    case 'UPSERT_COMPONENT':
      return set({ targets: { ...tgt, components: { ...(tgt.components ?? {}), [action.name]: action.target } } })
    case 'REMOVE_COMPONENT':
      return set({ targets: { ...tgt, components: withoutKey(tgt.components ?? {}, action.name) } })
    case 'NEXT':
      return { ...state, activeStep: state.activeStep + 1 }
    case 'BACK':
      return { ...state, activeStep: Math.max(0, state.activeStep - 1) }
    default:
      return state
  }
}

function countAll(map: Record<string, unknown> | undefined): number {
  return map ? Object.keys(map).length : 0
}

export function canContinue(state: ResiliencyState): boolean {
  const { config, activeStep } = state
  const { policies, targets } = config.spec
  switch (activeStep) {
    case 0:
      return validateResourceName(config.metadata.name) === null
    case 1:
      return countAll(policies.timeouts) + countAll(policies.retries) + countAll(policies.circuitBreakers) > 0
    case 2:
      return countAll(targets.apps) + countAll(targets.actors) + countAll(targets.components) > 0
    default:
      return true
  }
}

/** Build the emit object: name (+ namespace if set), no empty scopes, spec cleaned. */
export function assembleResiliency(config: DaprResiliency): Record<string, unknown> {
  const metadata: Record<string, unknown> = { name: config.metadata.name }
  if ((config.metadata.namespace ?? '').trim() !== '') metadata.namespace = config.metadata.namespace
  return {
    apiVersion: config.apiVersion,
    kind: config.kind,
    metadata,
    spec: recursivelyRemoveEmptyValues(config.spec),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- resiliency-builder/reducer`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/resiliency-builder/reducer.ts web/src/pages/resiliency-builder/reducer.test.ts
git commit -m "feat(web): add resiliency builder reducer + assembly + gating"
```

---

## Task 2: NamedList + policy dialogs

**Files:**
- Create: `web/src/pages/resiliency-builder/NamedList.tsx`
- Create: `web/src/pages/resiliency-builder/policyDialogs.tsx`
- Create: `web/src/pages/resiliency-builder/policyDialogs.test.tsx`

**Interfaces:**
- Produces:
  - `NamedList({ title, names, onAdd, onRemove })` — renders a section titled `title`, a chip/row per `name` with a remove button (`aria-label={`Remove ${name}`}`), and an "Add" button (`.btn.ghost`, `aria-label={`Add ${title}`}`) calling `onAdd`.
  - `TimeoutDialog({ open, initialName, onClose, onSave })` — `onSave(name: string, duration: string)`. Fields: name (`validateResourceName`) + duration (`validateGoDuration`). Confirm disabled until both valid.
  - `RetryDialog({ open, initialName, onClose, onSave })` — `onSave(name, policy: RetryPolicy)`. Fields: name; policy `constant|exponential` (SelectInput); duration (constant) / maxInterval (exponential), both go-duration; maxRetries (integer, default -1); matching.httpStatusCodes + matching.grpcStatusCodes (`validateStatusCodes`).
  - `CircuitBreakerDialog({ open, initialName, onClose, onSave })` — `onSave(name, policy: CircuitBreakerPolicy)`. Fields: name; maxRequests (integer); timeout (go-duration); trip (text, CEL); interval (go-duration).
- Consumes: `components/Modal`, `components/form/*`, `lib/validation`, `types/resiliency`.

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/resiliency-builder/policyDialogs.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { NamedList, TimeoutDialog, RetryDialog } from './policyDialogs'

describe('NamedList', () => {
  it('renders names, add, and remove', () => {
    const onAdd = vi.fn(); const onRemove = vi.fn()
    render(<NamedList title="Timeouts" names={['timeout1']} onAdd={onAdd} onRemove={onRemove} />)
    expect(screen.getByText('timeout1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /add timeouts/i }))
    expect(onAdd).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /remove timeout1/i }))
    expect(onRemove).toHaveBeenCalledWith('timeout1')
  })
})

describe('TimeoutDialog', () => {
  it('saves a valid name + duration and blocks invalid duration', () => {
    const onSave = vi.fn(); const onClose = vi.fn()
    render(<TimeoutDialog open initialName="timeout1" onClose={onClose} onSave={onSave} />)
    const confirm = screen.getByRole('button', { name: /save/i })
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: 'nope' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: '30s' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(onSave).toHaveBeenCalledWith('timeout1', '30s')
  })
})

describe('RetryDialog', () => {
  it('saves a constant retry policy', () => {
    const onSave = vi.fn()
    render(<RetryDialog open initialName="retry1" onClose={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText(/^duration/i), { target: { value: '5s' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('retry1', expect.objectContaining({ policy: 'constant', duration: '5s' }))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- resiliency-builder/policyDialogs`
Expected: FAIL — cannot resolve `./policyDialogs`.

- [ ] **Step 3: Implement `NamedList.tsx`**

Create `web/src/pages/resiliency-builder/NamedList.tsx`:
```tsx
interface NamedListProps {
  title: string
  names: string[]
  onAdd: () => void
  onRemove: (name: string) => void
}

export function NamedList({ title, names, onAdd, onRemove }: NamedListProps) {
  return (
    <div className="sbsection">
      <div className="sech">
        {title}
        <button type="button" className="btn ghost" style={{ marginLeft: 'auto' }} aria-label={`Add ${title}`} onClick={onAdd}>
          + Add
        </button>
      </div>
      {names.length === 0 ? (
        <p className="none">None yet.</p>
      ) : (
        names.map((name) => (
          <div key={name} className="chip k" style={{ marginRight: 6, marginBottom: 6 }}>
            <b>{name}</b>
            <button type="button" className="copybtn" aria-label={`Remove ${name}`} onClick={() => onRemove(name)}>✕</button>
          </div>
        ))
      )}
    </div>
  )
}
```

- [ ] **Step 4: Implement `policyDialogs.tsx`**

Create `web/src/pages/resiliency-builder/policyDialogs.tsx`:
```tsx
import { useState } from 'react'
import { Modal } from '../../components/Modal'
import { Field, TextInput, NumberInput, SelectInput } from '../../components/form'
import { validateResourceName, validateGoDuration, validateStatusCodes, integerError } from '../../lib/validation'
import type { RetryPolicy, CircuitBreakerPolicy } from '../../types/resiliency'
export { NamedList } from './NamedList'

function DialogShell({ open, title, onClose, onSave, canSave, children }: {
  open: boolean; title: string; onClose: () => void; onSave: () => void; canSave: boolean; children: React.ReactNode
}) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      {children}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn ghost" disabled={!canSave} onClick={onSave}>Save</button>
      </div>
    </Modal>
  )
}

export function TimeoutDialog({ open, initialName, onClose, onSave }: {
  open: boolean; initialName: string; onClose: () => void; onSave: (name: string, duration: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [duration, setDuration] = useState('')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const durOk = duration !== '' && validateGoDuration(duration).valid
  return (
    <DialogShell open={open} title="Add timeout policy" onClose={onClose} canSave={!nameErr && durOk}
      onSave={() => onSave(name, duration)}>
      <Field label="Name" required error={name === '' ? null : nameErr}>
        <TextInput aria-label="Timeout name" value={name} onChange={setName} />
      </Field>
      <Field label="Duration" required error={duration === '' ? null : (durOk ? null : validateGoDuration(duration).error)}>
        <TextInput aria-label="Duration" placeholder="30s" value={duration} onChange={setDuration} />
      </Field>
    </DialogShell>
  )
}

export function RetryDialog({ open, initialName, onClose, onSave }: {
  open: boolean; initialName: string; onClose: () => void; onSave: (name: string, policy: RetryPolicy) => void
}) {
  const [name, setName] = useState(initialName)
  const [policy, setPolicy] = useState<'constant' | 'exponential'>('constant')
  const [duration, setDuration] = useState('5s')
  const [maxInterval, setMaxInterval] = useState('60s')
  const [maxRetries, setMaxRetries] = useState('-1')
  const [http, setHttp] = useState('')
  const [grpc, setGrpc] = useState('')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const durField = policy === 'constant' ? duration : maxInterval
  const durOk = validateGoDuration(durField).valid
  const numOk = integerError(maxRetries) === null
  const codesOk = validateStatusCodes(http) === null && validateStatusCodes(grpc) === null
  const canSave = !nameErr && durOk && numOk && codesOk
  function save() {
    const p: RetryPolicy = {
      policy,
      maxRetries: maxRetries === '' ? undefined : Number(maxRetries),
      matching: { httpStatusCodes: http, grpcStatusCodes: grpc },
    }
    if (policy === 'constant') p.duration = duration
    else p.maxInterval = maxInterval
    onSave(name, p)
  }
  return (
    <DialogShell open={open} title="Add retry policy" onClose={onClose} canSave={canSave} onSave={save}>
      <Field label="Name" required error={name === '' ? null : nameErr}>
        <TextInput aria-label="Retry name" value={name} onChange={setName} />
      </Field>
      <Field label="Policy" required>
        <SelectInput aria-label="Retry policy type" value={policy}
          options={[{ label: 'constant', value: 'constant' }, { label: 'exponential', value: 'exponential' }]}
          onChange={(v) => setPolicy(v === 'exponential' ? 'exponential' : 'constant')} />
      </Field>
      {policy === 'constant' ? (
        <Field label="Duration" required error={durOk ? null : validateGoDuration(duration).error}>
          <TextInput aria-label="Duration" placeholder="5s" value={duration} onChange={setDuration} />
        </Field>
      ) : (
        <Field label="Max interval" required error={durOk ? null : validateGoDuration(maxInterval).error}>
          <TextInput aria-label="Max interval" placeholder="60s" value={maxInterval} onChange={setMaxInterval} />
        </Field>
      )}
      <Field label="Max retries" error={numOk ? null : 'Must be an integer'}>
        <NumberInput aria-label="Max retries" value={maxRetries} onChange={setMaxRetries} />
      </Field>
      <Field label="HTTP status codes" error={validateStatusCodes(http)}>
        <TextInput aria-label="HTTP status codes" placeholder="429,500-504" value={http} onChange={setHttp} />
      </Field>
      <Field label="gRPC status codes" error={validateStatusCodes(grpc)}>
        <TextInput aria-label="gRPC status codes" placeholder="4,8,14" value={grpc} onChange={setGrpc} />
      </Field>
    </DialogShell>
  )
}

export function CircuitBreakerDialog({ open, initialName, onClose, onSave }: {
  open: boolean; initialName: string; onClose: () => void; onSave: (name: string, policy: CircuitBreakerPolicy) => void
}) {
  const [name, setName] = useState(initialName)
  const [maxRequests, setMaxRequests] = useState('')
  const [timeout, setTimeout] = useState('')
  const [trip, setTrip] = useState('')
  const [interval, setInterval] = useState('')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const numOk = integerError(maxRequests) === null
  const toOk = validateGoDuration(timeout).valid
  const ivOk = validateGoDuration(interval).valid
  const canSave = !nameErr && numOk && toOk && ivOk
  function save() {
    onSave(name, {
      maxRequests: maxRequests === '' ? undefined : Number(maxRequests),
      timeout, trip, interval,
    })
  }
  return (
    <DialogShell open={open} title="Add circuit breaker policy" onClose={onClose} canSave={canSave} onSave={save}>
      <Field label="Name" required error={name === '' ? null : nameErr}>
        <TextInput aria-label="Circuit breaker name" value={name} onChange={setName} />
      </Field>
      <Field label="Max requests" error={numOk ? null : 'Must be an integer'}>
        <NumberInput aria-label="Max requests" value={maxRequests} onChange={setMaxRequests} />
      </Field>
      <Field label="Timeout" error={timeout === '' ? null : (toOk ? null : validateGoDuration(timeout).error)}>
        <TextInput aria-label="Timeout" placeholder="30s" value={timeout} onChange={setTimeout} />
      </Field>
      <Field label="Trip (CEL)">
        <TextInput aria-label="Trip" placeholder="consecutiveFailures >= 5" value={trip} onChange={setTrip} />
      </Field>
      <Field label="Interval" error={interval === '' ? null : (ivOk ? null : validateGoDuration(interval).error)}>
        <TextInput aria-label="Interval" placeholder="8s" value={interval} onChange={setInterval} />
      </Field>
    </DialogShell>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- resiliency-builder/policyDialogs`
Expected: PASS.

- [ ] **Step 6: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/resiliency-builder/NamedList.tsx web/src/pages/resiliency-builder/policyDialogs.tsx web/src/pages/resiliency-builder/policyDialogs.test.tsx
git commit -m "feat(web): add resiliency NamedList + policy dialogs"
```

---

## Task 3: Target dialogs

**Files:**
- Create: `web/src/pages/resiliency-builder/targetDialogs.tsx`
- Create: `web/src/pages/resiliency-builder/targetDialogs.test.tsx`

**Interfaces:**
- Produces:
  - `AppTargetDialog({ open, policies, onClose, onSave })` — `onSave(name, target: AppTarget)`. Fields: target name (`validateResourceName`) + `timeout`/`retry`/`circuitBreaker` SelectInputs sourced from `policies` (below). Confirm disabled until name valid AND ≥1 policy reference chosen.
  - `ActorTargetDialog({ open, policies, onClose, onSave })` — like App plus `circuitBreakerScope` (`type|id|both`, shown when circuitBreaker set) and `circuitBreakerCacheSize` (integer, shown when circuitBreaker set).
  - `ComponentTargetDialog({ open, policies, onClose, onSave })` — `onSave(name, target: ComponentTarget)`. Fields: name + direction (`outbound|inbound|both`) + timeout/retry/circuitBreaker for the applicable direction(s); ≥1 policy ref in the applicable direction required.
  - Shared prop `policies: { timeouts: string[]; retries: string[]; circuitBreakers: string[] }` (the named policies defined on step 1).
- Consumes: `components/Modal`, `components/form/*`, `lib/validation`, `types/resiliency`.

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/resiliency-builder/targetDialogs.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AppTargetDialog, ComponentTargetDialog } from './targetDialogs'

const policies = { timeouts: ['timeout1'], retries: ['retry1'], circuitBreakers: ['cb1'] }

describe('AppTargetDialog', () => {
  it('requires a name and at least one policy reference', () => {
    const onSave = vi.fn()
    render(<AppTargetDialog open policies={policies} onClose={vi.fn()} onSave={onSave} />)
    const save = screen.getByRole('button', { name: /save/i })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: 'orders' } })
    expect(save).toBeDisabled() // no policy chosen yet
    fireEvent.change(screen.getByLabelText(/^timeout/i), { target: { value: 'timeout1' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith('orders', expect.objectContaining({ timeout: 'timeout1' }))
  })
})

describe('ComponentTargetDialog', () => {
  it('saves an outbound-only component target', () => {
    const onSave = vi.fn()
    render(<ComponentTargetDialog open policies={policies} onClose={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText(/component name/i), { target: { value: 'statestore' } })
    fireEvent.change(screen.getByLabelText(/direction/i), { target: { value: 'outbound' } })
    fireEvent.change(screen.getByLabelText(/^retry/i), { target: { value: 'retry1' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('statestore', { outbound: { retry: 'retry1' } })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- resiliency-builder/targetDialogs`
Expected: FAIL — cannot resolve `./targetDialogs`.

- [ ] **Step 3: Implement `targetDialogs.tsx`**

Create `web/src/pages/resiliency-builder/targetDialogs.tsx`:
```tsx
import { useState } from 'react'
import { Modal } from '../../components/Modal'
import { Field, TextInput, NumberInput, SelectInput } from '../../components/form'
import { validateResourceName, integerError } from '../../lib/validation'
import type { AppTarget, ActorTarget, ComponentTarget } from '../../types/resiliency'

export interface PolicyNames {
  timeouts: string[]
  retries: string[]
  circuitBreakers: string[]
}

function opts(names: string[]) {
  return names.map((n) => ({ label: n, value: n }))
}

function Shell({ open, title, onClose, onSave, canSave, children }: {
  open: boolean; title: string; onClose: () => void; onSave: () => void; canSave: boolean; children: React.ReactNode
}) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      {children}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn ghost" disabled={!canSave} onClick={onSave}>Save</button>
      </div>
    </Modal>
  )
}

function PolicyPickers({ policies, timeout, retry, cb, setTimeout, setRetry, setCb }: {
  policies: PolicyNames
  timeout: string; retry: string; cb: string
  setTimeout: (v: string) => void; setRetry: (v: string) => void; setCb: (v: string) => void
}) {
  return (
    <>
      <Field label="Timeout policy"><SelectInput aria-label="Timeout policy" value={timeout} options={opts(policies.timeouts)} onChange={setTimeout} /></Field>
      <Field label="Retry policy"><SelectInput aria-label="Retry policy" value={retry} options={opts(policies.retries)} onChange={setRetry} /></Field>
      <Field label="Circuit breaker policy"><SelectInput aria-label="Circuit breaker policy" value={cb} options={opts(policies.circuitBreakers)} onChange={setCb} /></Field>
    </>
  )
}

export function AppTargetDialog({ open, policies, onClose, onSave }: {
  open: boolean; policies: PolicyNames; onClose: () => void; onSave: (name: string, target: AppTarget) => void
}) {
  const [name, setName] = useState('')
  const [timeout, setTimeout] = useState('')
  const [retry, setRetry] = useState('')
  const [cb, setCb] = useState('')
  const nameOk = validateResourceName(name) === null
  const anyPolicy = !!(timeout || retry || cb)
  function save() {
    const t: AppTarget = {}
    if (timeout) t.timeout = timeout
    if (retry) t.retry = retry
    if (cb) t.circuitBreaker = cb
    onSave(name, t)
  }
  return (
    <Shell open={open} title="Add app target" onClose={onClose} canSave={nameOk && anyPolicy} onSave={save}>
      <Field label="App ID" required error={name === '' ? null : validateResourceName(name)}>
        <TextInput aria-label="App ID" value={name} onChange={setName} />
      </Field>
      <PolicyPickers policies={policies} timeout={timeout} retry={retry} cb={cb} setTimeout={setTimeout} setRetry={setRetry} setCb={setCb} />
    </Shell>
  )
}

export function ActorTargetDialog({ open, policies, onClose, onSave }: {
  open: boolean; policies: PolicyNames; onClose: () => void; onSave: (name: string, target: ActorTarget) => void
}) {
  const [name, setName] = useState('')
  const [timeout, setTimeout] = useState('')
  const [retry, setRetry] = useState('')
  const [cb, setCb] = useState('')
  const [scope, setScope] = useState<'' | 'type' | 'id' | 'both'>('')
  const [cacheSize, setCacheSize] = useState('')
  const nameOk = validateResourceName(name) === null
  const anyPolicy = !!(timeout || retry || cb)
  const cacheOk = integerError(cacheSize) === null
  function save() {
    const t: ActorTarget = {}
    if (timeout) t.timeout = timeout
    if (retry) t.retry = retry
    if (cb) {
      t.circuitBreaker = cb
      if (scope) t.circuitBreakerScope = scope
      if (cacheSize) t.circuitBreakerCacheSize = Number(cacheSize)
    }
    onSave(name, t)
  }
  return (
    <Shell open={open} title="Add actor target" onClose={onClose} canSave={nameOk && anyPolicy && cacheOk} onSave={save}>
      <Field label="Actor type" required error={name === '' ? null : validateResourceName(name)}>
        <TextInput aria-label="Actor type" value={name} onChange={setName} />
      </Field>
      <PolicyPickers policies={policies} timeout={timeout} retry={retry} cb={cb} setTimeout={setTimeout} setRetry={setRetry} setCb={setCb} />
      {cb && (
        <>
          <Field label="Circuit breaker scope">
            <SelectInput aria-label="Circuit breaker scope" value={scope}
              options={[{ label: 'type', value: 'type' }, { label: 'id', value: 'id' }, { label: 'both', value: 'both' }]}
              onChange={(v) => setScope((v as '' | 'type' | 'id' | 'both'))} />
          </Field>
          <Field label="Circuit breaker cache size" error={cacheOk ? null : 'Must be an integer'}>
            <NumberInput aria-label="Circuit breaker cache size" value={cacheSize} onChange={setCacheSize} />
          </Field>
        </>
      )}
    </Shell>
  )
}

export function ComponentTargetDialog({ open, policies, onClose, onSave }: {
  open: boolean; policies: PolicyNames; onClose: () => void; onSave: (name: string, target: ComponentTarget) => void
}) {
  const [name, setName] = useState('')
  const [direction, setDirection] = useState<'outbound' | 'inbound' | 'both'>('outbound')
  const [timeout, setTimeout] = useState('')
  const [retry, setRetry] = useState('')
  const [cb, setCb] = useState('')
  const nameOk = validateResourceName(name) === null
  const anyPolicy = !!(timeout || retry || cb)
  function leg() {
    const l: { timeout?: string; retry?: string; circuitBreaker?: string } = {}
    if (timeout) l.timeout = timeout
    if (retry) l.retry = retry
    if (cb) l.circuitBreaker = cb
    return l
  }
  function save() {
    const t: ComponentTarget = {}
    if (direction === 'outbound' || direction === 'both') t.outbound = leg()
    if (direction === 'inbound' || direction === 'both') t.inbound = leg()
    onSave(name, t)
  }
  return (
    <Shell open={open} title="Add component target" onClose={onClose} canSave={nameOk && anyPolicy} onSave={save}>
      <Field label="Component name" required error={name === '' ? null : validateResourceName(name)}>
        <TextInput aria-label="Component name" value={name} onChange={setName} />
      </Field>
      <Field label="Direction" required>
        <SelectInput aria-label="Direction" value={direction}
          options={[{ label: 'outbound', value: 'outbound' }, { label: 'inbound', value: 'inbound' }, { label: 'both', value: 'both' }]}
          onChange={(v) => setDirection(v === 'inbound' ? 'inbound' : v === 'both' ? 'both' : 'outbound')} />
      </Field>
      <PolicyPickers policies={policies} timeout={timeout} retry={retry} cb={cb} setTimeout={setTimeout} setRetry={setRetry} setCb={setCb} />
    </Shell>
  )
}
```
Note: `SelectInput` renders a leading blank `—` option (value `''`), so an unset policy picker yields `''` and is omitted from the target — matching the test's outbound-only `{ outbound: { retry: 'retry1' } }` expectation.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- resiliency-builder/targetDialogs`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/resiliency-builder/targetDialogs.tsx web/src/pages/resiliency-builder/targetDialogs.test.tsx
git commit -m "feat(web): add resiliency target dialogs (app/actor/component)"
```

---

## Task 4: Step components (General, Policies, Targets)

**Files:**
- Create: `web/src/pages/resiliency-builder/StepGeneral.tsx`
- Create: `web/src/pages/resiliency-builder/StepPolicies.tsx`
- Create: `web/src/pages/resiliency-builder/StepTargets.tsx`
- Create: `web/src/pages/resiliency-builder/steps.test.tsx`

**Interfaces:**
- Produces (all take `{ state, dispatch }` with reducer types):
  - `StepGeneral` — name (`validateResourceName` error) + optional namespace.
  - `StepPolicies` — three `NamedList`s (Timeouts/Retries/Circuit breakers); "+ Add" opens the matching dialog with a defaulted `nextName`; dialog save dispatches the matching `UPSERT_*`; remove dispatches `REMOVE_*`.
  - `StepTargets` — three `NamedList`s (Apps/Actors/Components); "+ Add" opens the matching target dialog seeded with the named policies from state; save dispatches the matching `UPSERT_*`; remove dispatches `REMOVE_*`.
- Consumes: `NamedList`, policy + target dialogs, reducer (`nextName`, `Action`, `ResiliencyState`), `components/form`.

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/resiliency-builder/steps.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StepGeneral } from './StepGeneral'
import { StepPolicies } from './StepPolicies'
import { initialState, reducer } from './reducer'

describe('StepGeneral', () => {
  it('dispatches SET_NAME', () => {
    const dispatch = vi.fn()
    render(<StepGeneral state={initialState()} dispatch={dispatch} />)
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'my-res' } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_NAME', name: 'my-res' })
  })
})

describe('StepPolicies', () => {
  it('opens the timeout dialog and dispatches UPSERT_TIMEOUT on save', () => {
    const dispatch = vi.fn()
    render(<StepPolicies state={initialState()} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /add timeouts/i }))
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: '30s' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
  })
  it('lists an existing retry and removes it', () => {
    const dispatch = vi.fn()
    const s = reducer(initialState(), { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s' } })
    render(<StepPolicies state={s} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /remove retry1/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_RETRY', name: 'retry1' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- resiliency-builder/steps`
Expected: FAIL — cannot resolve `./StepGeneral`.

- [ ] **Step 3: Implement `StepGeneral.tsx`**

```tsx
import { Field, TextInput } from '../../components/form'
import { validateResourceName } from '../../lib/validation'
import type { Action, ResiliencyState } from './reducer'

export function StepGeneral({ state, dispatch }: { state: ResiliencyState; dispatch: (a: Action) => void }) {
  const name = state.config.metadata.name
  const nameErr = name === '' ? null : validateResourceName(name)
  return (
    <div>
      <Field label="Name" htmlFor="r-name" required error={nameErr}>
        <TextInput id="r-name" aria-label="Name" value={name} onChange={(v) => dispatch({ type: 'SET_NAME', name: v })} />
      </Field>
      <Field label="Namespace" htmlFor="r-ns">
        <TextInput id="r-ns" aria-label="Namespace" value={state.config.metadata.namespace ?? ''} onChange={(v) => dispatch({ type: 'SET_NAMESPACE', namespace: v })} />
      </Field>
    </div>
  )
}
```

- [ ] **Step 4: Implement `StepPolicies.tsx`**

```tsx
import { useState } from 'react'
import { NamedList } from './NamedList'
import { TimeoutDialog, RetryDialog, CircuitBreakerDialog } from './policyDialogs'
import { nextName, type Action, type ResiliencyState } from './reducer'

type Open = null | 'timeout' | 'retry' | 'cb'

export function StepPolicies({ state, dispatch }: { state: ResiliencyState; dispatch: (a: Action) => void }) {
  const [open, setOpen] = useState<Open>(null)
  const pol = state.config.spec.policies
  return (
    <div>
      <NamedList title="Timeouts" names={Object.keys(pol.timeouts)} onAdd={() => setOpen('timeout')} onRemove={(name) => dispatch({ type: 'REMOVE_TIMEOUT', name })} />
      <NamedList title="Retries" names={Object.keys(pol.retries)} onAdd={() => setOpen('retry')} onRemove={(name) => dispatch({ type: 'REMOVE_RETRY', name })} />
      <NamedList title="Circuit breakers" names={Object.keys(pol.circuitBreakers)} onAdd={() => setOpen('cb')} onRemove={(name) => dispatch({ type: 'REMOVE_CB', name })} />

      <TimeoutDialog open={open === 'timeout'} initialName={nextName('timeout', pol.timeouts)} onClose={() => setOpen(null)}
        onSave={(name, duration) => { dispatch({ type: 'UPSERT_TIMEOUT', name, duration }); setOpen(null) }} />
      <RetryDialog open={open === 'retry'} initialName={nextName('retry', pol.retries)} onClose={() => setOpen(null)}
        onSave={(name, policy) => { dispatch({ type: 'UPSERT_RETRY', name, policy }); setOpen(null) }} />
      <CircuitBreakerDialog open={open === 'cb'} initialName={nextName('circuitBreaker', pol.circuitBreakers)} onClose={() => setOpen(null)}
        onSave={(name, policy) => { dispatch({ type: 'UPSERT_CB', name, policy }); setOpen(null) }} />
    </div>
  )
}
```

- [ ] **Step 5: Implement `StepTargets.tsx`**

```tsx
import { useState } from 'react'
import { NamedList } from './NamedList'
import { AppTargetDialog, ActorTargetDialog, ComponentTargetDialog, type PolicyNames } from './targetDialogs'
import { type Action, type ResiliencyState } from './reducer'

type Open = null | 'app' | 'actor' | 'component'

export function StepTargets({ state, dispatch }: { state: ResiliencyState; dispatch: (a: Action) => void }) {
  const [open, setOpen] = useState<Open>(null)
  const { policies, targets } = state.config.spec
  const names: PolicyNames = {
    timeouts: Object.keys(policies.timeouts),
    retries: Object.keys(policies.retries),
    circuitBreakers: Object.keys(policies.circuitBreakers),
  }
  return (
    <div>
      <NamedList title="Apps" names={Object.keys(targets.apps ?? {})} onAdd={() => setOpen('app')} onRemove={(name) => dispatch({ type: 'REMOVE_APP', name })} />
      <NamedList title="Actors" names={Object.keys(targets.actors ?? {})} onAdd={() => setOpen('actor')} onRemove={(name) => dispatch({ type: 'REMOVE_ACTOR', name })} />
      <NamedList title="Components" names={Object.keys(targets.components ?? {})} onAdd={() => setOpen('component')} onRemove={(name) => dispatch({ type: 'REMOVE_COMPONENT', name })} />

      <AppTargetDialog open={open === 'app'} policies={names} onClose={() => setOpen(null)}
        onSave={(name, target) => { dispatch({ type: 'UPSERT_APP', name, target }); setOpen(null) }} />
      <ActorTargetDialog open={open === 'actor'} policies={names} onClose={() => setOpen(null)}
        onSave={(name, target) => { dispatch({ type: 'UPSERT_ACTOR', name, target }); setOpen(null) }} />
      <ComponentTargetDialog open={open === 'component'} policies={names} onClose={() => setOpen(null)}
        onSave={(name, target) => { dispatch({ type: 'UPSERT_COMPONENT', name, target }); setOpen(null) }} />
    </div>
  )
}
```

- [ ] **Step 6: Run the test + type-check**

Run: `npm test -- resiliency-builder/steps` → PASS. Run: `npx tsc -b` → 0.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/resiliency-builder/StepGeneral.tsx web/src/pages/resiliency-builder/StepPolicies.tsx web/src/pages/resiliency-builder/StepTargets.tsx web/src/pages/resiliency-builder/steps.test.tsx
git commit -m "feat(web): add resiliency builder step components"
```

---

## Task 5: Assemble ResiliencyBuilder + landing + nav + routes

**Files:**
- Create: `web/src/pages/resiliency-builder/ResiliencyBuilder.tsx`
- Create: `web/src/pages/resiliency-builder/ResiliencyBuilder.test.tsx`
- Create: `web/src/pages/Resiliency.tsx`
- Create: `web/src/pages/Resiliency.test.tsx`
- Modify: `web/src/router.tsx`
- Modify: `web/src/components/TopNav.tsx`

**Interfaces:**
- Consumes: `components/wizard` (`Wizard`, `WizardStep`), `components/YamlPreview`, reducer (`initialState`, `reducer`, `canContinue`, `assembleResiliency`), `lib/yaml-emit` (`dumpYaml`), the three step components, `react-router-dom`.
- Produces: `ResiliencyBuilder` page; `Resiliency` landing page; routes `/resiliency` and `/resiliency/new`; `Resiliency` nav item.

- [ ] **Step 1: Write the failing tests**

Create `web/src/pages/Resiliency.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { Resiliency } from './Resiliency'

describe('Resiliency landing', () => {
  it('shows the empty state and a New resiliency policy link', () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Resiliency /></MemoryRouter>)
    expect(screen.getByText(/no resiliency policies/i)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /new resiliency policy/i })
    expect(link).toHaveAttribute('href', '/resiliency/new')
  })
})
```

Create `web/src/pages/resiliency-builder/ResiliencyBuilder.test.tsx`:
```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { ResiliencyBuilder } from './ResiliencyBuilder'

function renderBuilder() {
  const router = createMemoryRouter(
    [{ path: '/resiliency/new', element: <ResiliencyBuilder /> }, { path: '/resiliency', element: <div>resiliency list</div> }],
    { initialEntries: ['/resiliency/new'], future: { v7_relativeSplatPath: true } },
  )
  return render(<RouterProvider router={router} future={{ v7_startTransition: true }} />)
}

describe('ResiliencyBuilder', () => {
  it('walks general → policies → targets → preview and emits YAML', async () => {
    renderBuilder()
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'my-res' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 0->1
    fireEvent.click(screen.getByRole('button', { name: /add timeouts/i }))
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: '30s' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 1->2
    fireEvent.click(screen.getByRole('button', { name: /add apps/i }))
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: 'orders' } })
    fireEvent.change(screen.getByLabelText(/^timeout policy/i), { target: { value: 'timeout1' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 2->3
    await waitFor(() => expect(document.querySelector('pre.code')?.textContent).toContain('kind: Resiliency'))
    expect(document.querySelector('pre.code')?.textContent).toContain('name: my-res')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- Resiliency` (both files)
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Implement `ResiliencyBuilder.tsx`**

```tsx
import { useMemo, useReducer } from 'react'
import { useNavigate } from 'react-router-dom'
import { Wizard, type WizardStep } from '../../components/wizard'
import { YamlPreview } from '../../components/YamlPreview'
import { dumpYaml } from '../../lib/yaml-emit'
import { initialState, reducer, canContinue, assembleResiliency } from './reducer'
import { StepGeneral } from './StepGeneral'
import { StepPolicies } from './StepPolicies'
import { StepTargets } from './StepTargets'

export function ResiliencyBuilder() {
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(reducer, undefined, initialState)

  const yaml = useMemo(
    () => (state.activeStep === 3 ? dumpYaml(assembleResiliency(state.config)) : ''),
    [state],
  )

  const steps: WizardStep[] = [
    { label: 'General', content: <StepGeneral state={state} dispatch={dispatch} /> },
    { label: 'Policies', content: <StepPolicies state={state} dispatch={dispatch} /> },
    { label: 'Targets', content: <StepTargets state={state} dispatch={dispatch} /> },
    { label: 'Preview', content: <YamlPreview yaml={yaml} filename={`${state.config.metadata.name || 'resiliency'}.yaml`} /> },
  ]

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>New resiliency policy</h1>
          <div className="sub">Build a Dapr resiliency YAML to copy or download</div>
        </div>
        <button type="button" className="btn ghost" onClick={() => navigate('/resiliency')}>Cancel</button>
      </div>
      <div className="card" style={{ padding: 18 }}>
        <Wizard
          steps={steps}
          activeStep={state.activeStep}
          canContinue={canContinue(state)}
          onBack={() => dispatch({ type: 'BACK' })}
          onContinue={() => dispatch({ type: 'NEXT' })}
          onFinish={() => navigate('/resiliency')}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Implement `Resiliency.tsx` (landing)**

```tsx
import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export function Resiliency() {
  useDocumentTitle('Resiliency')
  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>Resiliency</h1>
          <div className="sub">Dapr resiliency policies</div>
        </div>
        <Link className="btn ghost" to="/resiliency/new">+ New resiliency policy</Link>
      </div>
      <div className="md">
        <div className="card complist" />
        <div className="card">
          <p className="hint" style={{ padding: '14px' }}>
            No resiliency policies. Use "New resiliency policy" to build one.
          </p>
        </div>
      </div>
    </div>
  )
}
```
Note: confirm `useDocumentTitle` is exported from `web/src/lib/useDocumentTitle.ts` (it is used by `ResourceList`); if the import path/signature differs, match the existing usage.

- [ ] **Step 5: Add routes + nav item**

Modify `web/src/router.tsx`: import both pages and add routes (order doesn't matter — no param collision):
```tsx
import { Resiliency } from './pages/Resiliency'
import { ResiliencyBuilder } from './pages/resiliency-builder/ResiliencyBuilder'
// ...
      { path: 'resiliency', element: <Resiliency /> },
      { path: 'resiliency/new', element: <ResiliencyBuilder /> },
```

Modify `web/src/components/TopNav.tsx`: add the nav item between Configurations and Logs in `NAV_ITEMS`:
```tsx
  { label: 'Configurations', to: '/configurations' },
  { label: 'Resiliency', to: '/resiliency' },
  { label: 'Logs', to: '/logs' },
```

- [ ] **Step 6: Run the tests + full suite**

Run: `npm test -- Resiliency` → both PASS.
Run: `npm test` → all green. Note: `TopNav.test.tsx` asserts exactly 7 nav items in a specific order — UPDATE it to expect 8 items with `Resiliency` inserted between `Configurations` and `Logs` (both the labels array and the paths array). This is a legitimate spec change (new nav item), not a weakening.

- [ ] **Step 7: Type-check**

Run: `npx tsc -b` → 0.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/resiliency-builder/ResiliencyBuilder.tsx web/src/pages/resiliency-builder/ResiliencyBuilder.test.tsx web/src/pages/Resiliency.tsx web/src/pages/Resiliency.test.tsx web/src/router.tsx web/src/components/TopNav.tsx web/src/components/TopNav.test.tsx
git commit -m "feat(web): wire Resiliency Builder route, landing page, and nav item"
```

---

## Self-Review

**Spec coverage (Resiliency Builder):**
- 4-step flow General → Policies → Targets → Preview → Tasks 4, 5. ✓
- Step 0 = name only (connected-mode `ResiliencyAccess` dropped) → StepGeneral (Task 4); documented in Global Constraints. ✓
- Policies: timeouts/retries/circuitBreakers, each list + Add dialog; ≥1 policy to proceed → Tasks 2, 4 + reducer gating (Task 1). ✓
- Targets: apps/actors/components referencing named policies via dropdowns; actors add scope + cache size; components add inbound/outbound; ≥1 target to proceed → Tasks 3, 4 + gating (Task 1). ✓
- DaprBuiltIn default-policy override table DROPPED for v1 → documented in Global Constraints. ✓
- Preview: `recursivelyRemoveEmptyValues` over spec, read-only highlighted `<pre>`, copy/download → Task 1 `assembleResiliency` + Task 5 using `YamlPreview`. ✓
- `grpcStatusCodes` spelling → RetryDialog + types (Task 2). ✓
- Sequential policy/target naming (`retry1`…) → `nextName` (Task 1), used by StepPolicies. ✓
- Monochrome buttons in wizard + dialogs (`.btn.mono`/`.btn.ghost`) → Tasks 2, 3, 5. ✓
- Resiliency nav item + `/resiliency` create-only landing + `/resiliency/new` → Task 5. ✓
- Finish/Cancel → `/resiliency` → Task 5. ✓
- Reuse of `Modal`, Plan 1 form/wizard, Plan 2 `YamlPreview` → throughout. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code + commands with expected results. Two "confirm the real API" notes (Task 5 `useDocumentTitle`; Task 5 `TopNav.test.tsx` update) are verification steps, not placeholders.

**Type consistency:** `ResiliencyState`/`Action` (Task 1) consumed identically by steps (Task 4) and page (Task 5). `RetryPolicy`/`CircuitBreakerPolicy`/`AppTarget`/`ActorTarget`/`ComponentTarget` from `types/resiliency` used consistently across dialogs (Tasks 2–3) and reducer (Task 1). `PolicyNames` shape shared between target dialogs and StepTargets. `UPSERT_*`/`REMOVE_*` action names match between reducer, steps, and tests. `nextName(prefix, existing)` and `assembleResiliency(config)` signatures consistent. `YamlPreview` (Plan 2, updated in Plan 2 Task 4) read-only API `({ yaml, filename })` — no `onEditedChange`, no `previewEdited` state. `canContinue(state)` used directly; Finish always enabled on preview step.

**Cross-plan note:** This plan depends on Plan 2's `components/YamlPreview.tsx`. If Plans are executed out of order, Task 5 (and its test) will fail until `YamlPreview` exists — execute Plan 2 first.
