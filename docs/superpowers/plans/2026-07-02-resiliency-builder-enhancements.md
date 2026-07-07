# Resiliency Builder Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the shipped Resiliency Builder: default the namespace to `default`, show real (editable) default values in dialogs, make policy AND target chips editable by clicking them, and add an "override default Dapr policies" feature (the reserved `DaprBuiltIn*` retries).

**Architecture:** Additive changes to the existing `web/src/pages/resiliency-builder/*` wizard. The `DaprResiliency` type and `useReducer` actions are reused unchanged except the namespace default and the Targets-step gating. Editing reuses the existing `UPSERT_*` actions (rename = `REMOVE_<old>` + `UPSERT_<new>`). A new `defaultPolicies.ts` module holds the built-in retry presets and helpers.

**Tech Stack:** React 19, TS, Vite, React Router v6, Vitest + Testing Library. No new dependencies.

**Prereq:** The Resiliency Builder exists and passes on branch `feat/component-resiliency-builders`.
**Source spec:** `docs/superpowers/specs/2026-07-02-resiliency-builder-enhancements-design.md`

## Global Constraints

- **No new dependencies.** Controlled components; vanilla CSS theme tokens; reuse `components/form/*`, `components/Modal`.
- **Wizard/dialog buttons stay `btn ghost`** (never green `btn.primary`), matching existing dialogs.
- **Emit rule (unchanged):** `assembleResiliency` cleans only `spec` with `recursivelyRemoveEmptyValues`; assembles `metadata.name` (+ `namespace` only when its trimmed value is non-empty); omits empty `scopes`.
- **Reserved override keys:** the 4 `DaprBuiltIn*` names are stored under `spec.policies.retries`; their name is locked in the dialog and they render only in the overrides section (filtered out of the regular Retries list).
- **Do NOT modify** shared `components/form/TextInput.tsx` — a locked name renders as static read-only text inside the dialog instead.
- **Tests:** Vitest + Testing Library, colocated. Run `npx tsc -b` before every commit. All `npm`/`npx` from `web/`.

---

## File Structure

- Modify `web/src/types/resiliency.ts` — namespace default `'default'`.
- Create `web/src/pages/resiliency-builder/defaultPolicies.ts` — built-in retry presets + `isDefaultPolicyName` + `presetToRetryPolicy`.
- Modify `web/src/pages/resiliency-builder/reducer.ts` — override-aware Targets gating.
- Modify `web/src/pages/resiliency-builder/policyDialogs.tsx` — real defaults; edit-mode + lock-name + keep-duration props; mode-aware titles.
- Modify `web/src/pages/resiliency-builder/targetDialogs.tsx` — edit-mode props; mode-aware titles; component-direction derivation.
- Modify `web/src/pages/resiliency-builder/NamedList.tsx` — optional `onEdit` + clickable chip body.
- Modify `web/src/pages/resiliency-builder/StepPolicies.tsx` — edit wiring; overrides section; retries filter.
- Modify `web/src/pages/resiliency-builder/StepTargets.tsx` — edit wiring.
- Test files (colocated): `reducer.test.ts`, `defaultPolicies.test.ts` (new), `policyDialogs.test.tsx`, `targetDialogs.test.tsx`, `steps.test.tsx`, `ResiliencyBuilder.test.tsx`.

---

## Task 1: Namespace defaults to `default`

**Files:**
- Modify: `web/src/types/resiliency.ts:61` (`defaultResiliencyConfig` metadata)
- Test: `web/src/pages/resiliency-builder/reducer.test.ts`

**Interfaces:**
- Consumes: `defaultResiliencyConfig(): DaprResiliency`, `assembleResiliency(config): Record<string, unknown>`, `reducer`, `initialState` (existing).
- Produces: `defaultResiliencyConfig()` now returns `metadata.namespace === 'default'`.

- [ ] **Step 1: Update the assemble test to expect the default namespace**

In `reducer.test.ts`, replace the `assembleResiliency` describe block (currently lines ~45-55) with:

```ts
describe('assembleResiliency', () => {
  it('keeps name + default namespace, cleans spec, omits empty scopes', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s', maxRetries: 3, maxInterval: '', matching: { httpStatusCodes: '', grpcStatusCodes: '' } } })
    const out = assembleResiliency(s.config) as any
    expect(out.metadata).toEqual({ name: 'r', namespace: 'default' })
    expect(out.scopes).toBeUndefined()
    expect(out.spec.policies.retries.retry1).toEqual({ policy: 'constant', duration: '5s', maxRetries: 3 })
  })
  it('omits namespace when cleared', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'SET_NAMESPACE', namespace: '' })
    const out = assembleResiliency(s.config) as any
    expect(out.metadata).toEqual({ name: 'r' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/resiliency-builder/reducer.test.ts`
Expected: FAIL — `metadata` is `{ name: 'r' }`, expected `{ name: 'r', namespace: 'default' }`.

- [ ] **Step 3: Set the default namespace**

In `web/src/types/resiliency.ts`, in `defaultResiliencyConfig()`, change:

```ts
    metadata: { name: '', namespace: '' },
```

to:

```ts
    metadata: { name: '', namespace: 'default' },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/resiliency-builder/reducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd web && npx tsc -b
git add web/src/types/resiliency.ts web/src/pages/resiliency-builder/reducer.test.ts
git commit -m "feat(web): default resiliency namespace to 'default'"
```

---

## Task 2: Built-in retry presets module

**Files:**
- Create: `web/src/pages/resiliency-builder/defaultPolicies.ts`
- Test: `web/src/pages/resiliency-builder/defaultPolicies.test.ts`

**Interfaces:**
- Consumes: `RetryPolicy` from `../../types/resiliency`.
- Produces:
  - `interface DefaultPolicyPreset { label: string; policy: 'constant' | 'exponential'; duration: string; maxInterval: string; maxRetries: number }`
  - `DEFAULT_DAPR_RETRY_POLICIES: DefaultPolicyPreset[]` (length 4)
  - `isDefaultPolicyName(name: string): boolean`
  - `presetToRetryPolicy(p: DefaultPolicyPreset): RetryPolicy`

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/resiliency-builder/defaultPolicies.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_DAPR_RETRY_POLICIES, isDefaultPolicyName, presetToRetryPolicy } from './defaultPolicies'

describe('DEFAULT_DAPR_RETRY_POLICIES', () => {
  it('has the four Dapr built-in retry policies with documented defaults', () => {
    expect(DEFAULT_DAPR_RETRY_POLICIES).toHaveLength(4)
    const service = DEFAULT_DAPR_RETRY_POLICIES.find((p) => p.label === 'DaprBuiltInServiceRetries')
    expect(service).toEqual({ label: 'DaprBuiltInServiceRetries', policy: 'constant', duration: '1s', maxInterval: '', maxRetries: 3 })
    const reminder = DEFAULT_DAPR_RETRY_POLICIES.find((p) => p.label === 'DaprBuiltInActorReminderRetries')
    expect(reminder).toEqual({ label: 'DaprBuiltInActorReminderRetries', policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 })
  })
})

describe('isDefaultPolicyName', () => {
  it('matches only DaprBuiltIn* names', () => {
    expect(isDefaultPolicyName('DaprBuiltInServiceRetries')).toBe(true)
    expect(isDefaultPolicyName('retry1')).toBe(false)
  })
})

describe('presetToRetryPolicy', () => {
  it('carries duration + maxInterval for exponential presets', () => {
    const reminder = DEFAULT_DAPR_RETRY_POLICIES.find((p) => p.label === 'DaprBuiltInActorReminderRetries')!
    expect(presetToRetryPolicy(reminder)).toEqual({ policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 })
  })
  it('drops empty maxInterval for constant presets', () => {
    const service = DEFAULT_DAPR_RETRY_POLICIES.find((p) => p.label === 'DaprBuiltInServiceRetries')!
    expect(presetToRetryPolicy(service)).toEqual({ policy: 'constant', duration: '1s', maxInterval: undefined, maxRetries: 3 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/resiliency-builder/defaultPolicies.test.ts`
Expected: FAIL — cannot find module `./defaultPolicies`.

- [ ] **Step 3: Create the module**

Create `web/src/pages/resiliency-builder/defaultPolicies.ts`:

```ts
import type { RetryPolicy } from '../../types/resiliency'

export interface DefaultPolicyPreset {
  label: string
  policy: 'constant' | 'exponential'
  duration: string
  maxInterval: string
  maxRetries: number
}

/** The four reserved Dapr built-in retry policies. */
export const DEFAULT_DAPR_RETRY_POLICIES: DefaultPolicyPreset[] = [
  { label: 'DaprBuiltInServiceRetries', policy: 'constant', duration: '1s', maxInterval: '', maxRetries: 3 },
  { label: 'DaprBuiltInActorRetries', policy: 'constant', duration: '1s', maxInterval: '', maxRetries: 3 },
  { label: 'DaprBuiltInActorReminderRetries', policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 },
  { label: 'DaprBuiltInInitializationRetries', policy: 'exponential', duration: '10s', maxInterval: '500ms', maxRetries: 3 },
]

/** True for the reserved built-in override keys (they live only in the overrides section). */
export function isDefaultPolicyName(name: string): boolean {
  return name.startsWith('DaprBuiltIn')
}

/** Convert a preset to a RetryPolicy; empty maxInterval becomes undefined so it isn't emitted for constant. */
export function presetToRetryPolicy(p: DefaultPolicyPreset): RetryPolicy {
  return {
    policy: p.policy,
    duration: p.duration,
    maxInterval: p.maxInterval || undefined,
    maxRetries: p.maxRetries,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/resiliency-builder/defaultPolicies.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd web && npx tsc -b
git add web/src/pages/resiliency-builder/defaultPolicies.ts web/src/pages/resiliency-builder/defaultPolicies.test.ts
git commit -m "feat(web): add Dapr built-in retry policy presets module"
```

---

## Task 3: Override-aware Targets-step gating

**Files:**
- Modify: `web/src/pages/resiliency-builder/reducer.ts` (`canContinue`, case 2)
- Test: `web/src/pages/resiliency-builder/reducer.test.ts`

**Interfaces:**
- Consumes: `isDefaultPolicyName` from `./defaultPolicies` (Task 2).
- Produces: `canContinue(state)` at step 2 returns true when there is ≥1 target OR ≥1 `DaprBuiltIn*` retry override.

- [ ] **Step 1: Write the failing test**

In `reducer.test.ts`, inside the `describe('canContinue', ...)` block, add:

```ts
  it('step 2 passes with a DaprBuiltIn override and no explicit target', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_RETRY', name: 'DaprBuiltInServiceRetries', policy: { policy: 'constant', duration: '1s', maxRetries: 3 } })
    s = reducer(s, { type: 'NEXT' }) // 0->1
    s = reducer(s, { type: 'NEXT' }) // 1->2
    expect(canContinue(s)).toBe(true)
  })
  it('step 2 fails with only a non-builtin retry and no target', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s' } })
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'NEXT' })
    expect(canContinue(s)).toBe(false)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/resiliency-builder/reducer.test.ts`
Expected: FAIL — the DaprBuiltIn-override case returns false (only targets counted).

- [ ] **Step 3: Update the gating**

In `web/src/pages/resiliency-builder/reducer.ts`, add the import near the top:

```ts
import { isDefaultPolicyName } from './defaultPolicies'
```

Replace the `case 2:` branch in `canContinue`:

```ts
    case 2:
      return countAll(targets.apps) + countAll(targets.actors) + countAll(targets.components) > 0
```

with:

```ts
    case 2: {
      const hasTarget = countAll(targets.apps) + countAll(targets.actors) + countAll(targets.components) > 0
      const hasOverride = Object.keys(policies.retries).some(isDefaultPolicyName)
      return hasTarget || hasOverride
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/resiliency-builder/reducer.test.ts`
Expected: PASS (existing step-2 test that adds an app still passes).

- [ ] **Step 5: Typecheck and commit**

```bash
cd web && npx tsc -b
git add web/src/pages/resiliency-builder/reducer.ts web/src/pages/resiliency-builder/reducer.test.ts
git commit -m "feat(web): allow finishing with a DaprBuiltIn override and no explicit target"
```

---

## Task 4: Editable chips in NamedList

**Files:**
- Modify: `web/src/pages/resiliency-builder/NamedList.tsx`
- Test: `web/src/pages/resiliency-builder/policyDialogs.test.tsx` (the `NamedList` describe block already lives here)

**Interfaces:**
- Consumes: nothing new.
- Produces: `NamedList({ title, names, onAdd, onRemove, onEdit? })` where `onEdit?: (name: string) => void`. When `onEdit` is provided, clicking the chip body (button labelled `Edit <name>`) fires `onEdit(name)`; the ✕ button still fires `onRemove(name)` and does not also trigger edit.

- [ ] **Step 1: Write the failing test**

In `policyDialogs.test.tsx`, replace the `NamedList` describe block with:

```ts
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
  it('fires onEdit from the chip body and not on remove', () => {
    const onEdit = vi.fn(); const onRemove = vi.fn()
    render(<NamedList title="Timeouts" names={['timeout1']} onAdd={vi.fn()} onRemove={onRemove} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole('button', { name: /edit timeout1/i }))
    expect(onEdit).toHaveBeenCalledWith('timeout1')
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /remove timeout1/i }))
    expect(onRemove).toHaveBeenCalledWith('timeout1')
    expect(onEdit).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/resiliency-builder/policyDialogs.test.tsx`
Expected: FAIL — no `Edit timeout1` button.

- [ ] **Step 3: Implement the clickable chip body**

Replace `web/src/pages/resiliency-builder/NamedList.tsx` with:

```tsx
interface NamedListProps {
  title: string
  names: string[]
  onAdd: () => void
  onRemove: (name: string) => void
  onEdit?: (name: string) => void
}

export function NamedList({ title, names, onAdd, onRemove, onEdit }: NamedListProps) {
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
            {onEdit ? (
              <button
                type="button"
                className="chip-edit"
                aria-label={`Edit ${name}`}
                onClick={() => onEdit(name)}
                style={{ background: 'none', border: 0, cursor: 'pointer', font: 'inherit', padding: 0 }}
              >
                <b>{name}</b>
              </button>
            ) : (
              <b>{name}</b>
            )}
            <button
              type="button"
              className="copybtn"
              aria-label={`Remove ${name}`}
              onClick={(e) => { e.stopPropagation(); onRemove(name) }}
            >
              ✕
            </button>
          </div>
        ))
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/resiliency-builder/policyDialogs.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd web && npx tsc -b
git add web/src/pages/resiliency-builder/NamedList.tsx web/src/pages/resiliency-builder/policyDialogs.test.tsx
git commit -m "feat(web): make resiliency NamedList chips editable via onEdit"
```

---

## Task 5: Policy dialogs — real defaults, edit mode, locked name, keep-duration

**Files:**
- Modify: `web/src/pages/resiliency-builder/policyDialogs.tsx`
- Test: `web/src/pages/resiliency-builder/policyDialogs.test.tsx`

**Interfaces:**
- Consumes: `RetryPolicy`, `CircuitBreakerPolicy` from `../../types/resiliency`.
- Produces (new/changed dialog props):
  - `TimeoutDialog({ open, initialName, initialDuration?, editing?, onClose, onSave })` — duration defaults to `initialDuration ?? '5s'`; title `Edit`/`Add timeout policy`.
  - `RetryDialog({ open, initialName, initialPolicy?, editing?, lockName?, keepDurationForExponential?, onClose, onSave })` — fields default from `initialPolicy` (fallback `constant`/`5s`/`60s`/`-1`); when `lockName`, the name renders as static read-only text; when `keepDurationForExponential`, an exponential save also emits `duration`.
  - `CircuitBreakerDialog({ open, initialName, initialPolicy?, editing?, onClose, onSave })` — defaults `maxRequests 1`, `timeout 45s`, `trip 'consecutiveFailures >= 5'`, `interval 8s`; title `Edit`/`Add circuit breaker policy`.
  - `onSave` signatures unchanged: `(name, duration)` / `(name, policy)`.

- [ ] **Step 1: Write the failing tests**

In `policyDialogs.test.tsx`, add `CircuitBreakerDialog` to the import line and add these describe blocks:

```ts
import { NamedList, TimeoutDialog, RetryDialog, CircuitBreakerDialog } from './policyDialogs'
```

```ts
describe('TimeoutDialog defaults + edit', () => {
  it('prefills 5s on add', () => {
    render(<TimeoutDialog open initialName="timeout1" onClose={vi.fn()} onSave={vi.fn()} />)
    expect((screen.getByLabelText(/duration/i) as HTMLInputElement).value).toBe('5s')
  })
  it('prefills the existing duration and title on edit', () => {
    const onSave = vi.fn()
    render(<TimeoutDialog open editing initialName="timeout1" initialDuration="42s" onClose={vi.fn()} onSave={onSave} />)
    expect(screen.getByText(/edit timeout policy/i)).toBeInTheDocument()
    expect((screen.getByLabelText(/duration/i) as HTMLInputElement).value).toBe('42s')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('timeout1', '42s')
  })
})

describe('CircuitBreakerDialog defaults', () => {
  it('prefills canonical defaults as real text', () => {
    render(<CircuitBreakerDialog open initialName="circuitBreaker1" onClose={vi.fn()} onSave={vi.fn()} />)
    expect((screen.getByLabelText(/max requests/i) as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText(/^timeout/i) as HTMLInputElement).value).toBe('45s')
    expect((screen.getByLabelText(/trip/i) as HTMLInputElement).value).toBe('consecutiveFailures >= 5')
    expect((screen.getByLabelText(/interval/i) as HTMLInputElement).value).toBe('8s')
  })
})

describe('RetryDialog edit + lock + keep-duration', () => {
  it('locks the name when lockName is set', () => {
    render(<RetryDialog open initialName="DaprBuiltInServiceRetries" lockName onClose={vi.fn()} onSave={vi.fn()} />)
    expect(screen.queryByLabelText(/retry name/i)).not.toBeInTheDocument()
    expect(screen.getByText('DaprBuiltInServiceRetries')).toBeInTheDocument()
  })
  it('keeps duration for an exponential override on save', () => {
    const onSave = vi.fn()
    render(
      <RetryDialog open editing lockName keepDurationForExponential
        initialName="DaprBuiltInActorReminderRetries"
        initialPolicy={{ policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 }}
        onClose={vi.fn()} onSave={onSave} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('DaprBuiltInActorReminderRetries', expect.objectContaining({ policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 }))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/pages/resiliency-builder/policyDialogs.test.tsx`
Expected: FAIL — CB defaults empty, no `editing`/`lockName`/`keepDurationForExponential` support.

- [ ] **Step 3: Update the three dialogs**

Replace `TimeoutDialog`, `RetryDialog`, and `CircuitBreakerDialog` in `web/src/pages/resiliency-builder/policyDialogs.tsx` with:

```tsx
export function TimeoutDialog({ open, initialName, initialDuration, editing, onClose, onSave }: {
  open: boolean; initialName: string; initialDuration?: string; editing?: boolean; onClose: () => void; onSave: (name: string, duration: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [duration, setDuration] = useState(initialDuration ?? '5s')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const durOk = duration !== '' && validateGoDuration(duration).valid
  return (
    <DialogShell open={open} title={editing ? 'Edit timeout policy' : 'Add timeout policy'} onClose={onClose} canSave={!nameErr && durOk}
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

export function RetryDialog({ open, initialName, initialPolicy, editing, lockName, keepDurationForExponential, onClose, onSave }: {
  open: boolean; initialName: string; initialPolicy?: RetryPolicy; editing?: boolean; lockName?: boolean; keepDurationForExponential?: boolean
  onClose: () => void; onSave: (name: string, policy: RetryPolicy) => void
}) {
  const [name, setName] = useState(initialName)
  const [policy, setPolicy] = useState<'constant' | 'exponential'>(initialPolicy?.policy ?? 'constant')
  const [duration, setDuration] = useState(initialPolicy?.duration ?? '5s')
  const [maxInterval, setMaxInterval] = useState(initialPolicy?.maxInterval ?? '60s')
  const [maxRetries, setMaxRetries] = useState(initialPolicy?.maxRetries?.toString() ?? '-1')
  const [http, setHttp] = useState(initialPolicy?.matching?.httpStatusCodes ?? '')
  const [grpc, setGrpc] = useState(initialPolicy?.matching?.grpcStatusCodes ?? '')
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
    if (policy === 'constant') {
      p.duration = duration
    } else {
      p.maxInterval = maxInterval
      if (keepDurationForExponential && duration !== '') p.duration = duration
    }
    onSave(name, p)
  }
  return (
    <DialogShell open={open} title={editing ? 'Edit retry policy' : 'Add retry policy'} onClose={onClose} canSave={canSave} onSave={save}>
      {lockName ? (
        <Field label="Name"><b>{name}</b></Field>
      ) : (
        <Field label="Name" required error={name === '' ? null : nameErr}>
          <TextInput aria-label="Retry name" value={name} onChange={setName} />
        </Field>
      )}
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

export function CircuitBreakerDialog({ open, initialName, initialPolicy, editing, onClose, onSave }: {
  open: boolean; initialName: string; initialPolicy?: CircuitBreakerPolicy; editing?: boolean; onClose: () => void; onSave: (name: string, policy: CircuitBreakerPolicy) => void
}) {
  const [name, setName] = useState(initialName)
  const [maxRequests, setMaxRequests] = useState(initialPolicy?.maxRequests?.toString() ?? '1')
  const [timeoutDur, setTimeoutDur] = useState(initialPolicy?.timeout ?? '45s')
  const [trip, setTrip] = useState(initialPolicy?.trip ?? 'consecutiveFailures >= 5')
  const [intervalDur, setIntervalDur] = useState(initialPolicy?.interval ?? '8s')
  const nameErr = name === '' ? 'Name is required' : validateResourceName(name)
  const numOk = integerError(maxRequests) === null
  const toOk = validateGoDuration(timeoutDur).valid
  const ivOk = validateGoDuration(intervalDur).valid
  const canSave = !nameErr && numOk && toOk && ivOk
  function save() {
    onSave(name, {
      maxRequests: maxRequests === '' ? undefined : Number(maxRequests),
      timeout: timeoutDur, trip, interval: intervalDur,
    })
  }
  return (
    <DialogShell open={open} title={editing ? 'Edit circuit breaker policy' : 'Add circuit breaker policy'} onClose={onClose} canSave={canSave} onSave={save}>
      <Field label="Name" required error={name === '' ? null : nameErr}>
        <TextInput aria-label="Circuit breaker name" value={name} onChange={setName} />
      </Field>
      <Field label="Max requests" error={numOk ? null : 'Must be an integer'}>
        <NumberInput aria-label="Max requests" value={maxRequests} onChange={setMaxRequests} />
      </Field>
      <Field label="Timeout" error={timeoutDur === '' ? null : (toOk ? null : validateGoDuration(timeoutDur).error)}>
        <TextInput aria-label="Timeout" placeholder="30s" value={timeoutDur} onChange={setTimeoutDur} />
      </Field>
      <Field label="Trip (CEL)">
        <TextInput aria-label="Trip" placeholder="consecutiveFailures >= 5" value={trip} onChange={setTrip} />
      </Field>
      <Field label="Interval" error={intervalDur === '' ? null : (ivOk ? null : validateGoDuration(intervalDur).error)}>
        <TextInput aria-label="Interval" placeholder="8s" value={intervalDur} onChange={setIntervalDur} />
      </Field>
    </DialogShell>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/pages/resiliency-builder/policyDialogs.test.tsx`
Expected: PASS (existing `TimeoutDialog`/`RetryDialog` save tests still pass).

- [ ] **Step 5: Typecheck and commit**

```bash
cd web && npx tsc -b
git add web/src/pages/resiliency-builder/policyDialogs.tsx web/src/pages/resiliency-builder/policyDialogs.test.tsx
git commit -m "feat(web): resiliency policy dialogs gain real defaults + edit/lock/keep-duration"
```

---

## Task 6: Target dialogs — edit mode + component-direction derivation

**Files:**
- Modify: `web/src/pages/resiliency-builder/targetDialogs.tsx`
- Test: `web/src/pages/resiliency-builder/targetDialogs.test.tsx`

**Interfaces:**
- Consumes: `AppTarget`, `ActorTarget`, `ComponentTarget` from `../../types/resiliency`; `PolicyNames` (existing).
- Produces (changed props):
  - `AppTargetDialog({ open, policies, initialName?, initialTarget?, editing?, onClose, onSave })`
  - `ActorTargetDialog({ open, policies, initialName?, initialTarget?, editing?, onClose, onSave })`
  - `ComponentTargetDialog({ open, policies, initialName?, initialTarget?, editing?, onClose, onSave })` — direction derived from `initialTarget` (both legs → `both`; else the present leg; default `outbound`); pickers prefill from `outbound` else `inbound`.
  - Titles `Edit`/`Add … target`. `onSave` signatures unchanged.

- [ ] **Step 1: Write the failing tests**

In `targetDialogs.test.tsx`, add:

```ts
describe('AppTargetDialog edit', () => {
  it('prefills name + policy refs and title on edit', () => {
    const onSave = vi.fn()
    render(<AppTargetDialog open editing policies={policies} initialName="orders" initialTarget={{ timeout: 'timeout1', retry: 'retry1' }} onClose={vi.fn()} onSave={onSave} />)
    expect(screen.getByText(/edit app target/i)).toBeInTheDocument()
    expect((screen.getByLabelText(/app id/i) as HTMLInputElement).value).toBe('orders')
    expect((screen.getByLabelText(/^timeout policy/i) as HTMLSelectElement).value).toBe('timeout1')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('orders', expect.objectContaining({ timeout: 'timeout1', retry: 'retry1' }))
  })
})

describe('ComponentTargetDialog edit', () => {
  it('derives both-direction and prefills from outbound leg', () => {
    render(<ComponentTargetDialog open editing policies={policies} initialName="statestore" initialTarget={{ outbound: { retry: 'retry1' }, inbound: { retry: 'retry1' } }} onClose={vi.fn()} onSave={vi.fn()} />)
    expect((screen.getByLabelText(/direction/i) as HTMLSelectElement).value).toBe('both')
    expect((screen.getByLabelText(/^retry policy/i) as HTMLSelectElement).value).toBe('retry1')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/pages/resiliency-builder/targetDialogs.test.tsx`
Expected: FAIL — dialogs ignore `initialName`/`initialTarget`/`editing`.

- [ ] **Step 3: Update the three target dialogs**

In `web/src/pages/resiliency-builder/targetDialogs.tsx`, replace the three exported dialog functions with:

```tsx
export function AppTargetDialog({ open, policies, initialName, initialTarget, editing, onClose, onSave }: {
  open: boolean; policies: PolicyNames; initialName?: string; initialTarget?: AppTarget; editing?: boolean; onClose: () => void; onSave: (name: string, target: AppTarget) => void
}) {
  const [name, setName] = useState(initialName ?? '')
  const [timeoutRef, setTimeoutRef] = useState(initialTarget?.timeout ?? '')
  const [retry, setRetry] = useState(initialTarget?.retry ?? '')
  const [cb, setCb] = useState(initialTarget?.circuitBreaker ?? '')
  const nameOk = validateResourceName(name) === null
  const anyPolicy = !!(timeoutRef || retry || cb)
  function save() {
    const t: AppTarget = {}
    if (timeoutRef) t.timeout = timeoutRef
    if (retry) t.retry = retry
    if (cb) t.circuitBreaker = cb
    onSave(name, t)
  }
  return (
    <Shell open={open} title={editing ? 'Edit app target' : 'Add app target'} onClose={onClose} canSave={nameOk && anyPolicy} onSave={save}>
      <Field label="App ID" required error={name === '' ? null : validateResourceName(name)}>
        <TextInput aria-label="App ID" value={name} onChange={setName} />
      </Field>
      <PolicyPickers policies={policies} timeout={timeoutRef} retry={retry} cb={cb} setTimeout={setTimeoutRef} setRetry={setRetry} setCb={setCb} />
    </Shell>
  )
}

export function ActorTargetDialog({ open, policies, initialName, initialTarget, editing, onClose, onSave }: {
  open: boolean; policies: PolicyNames; initialName?: string; initialTarget?: ActorTarget; editing?: boolean; onClose: () => void; onSave: (name: string, target: ActorTarget) => void
}) {
  const [name, setName] = useState(initialName ?? '')
  const [timeoutRef, setTimeoutRef] = useState(initialTarget?.timeout ?? '')
  const [retry, setRetry] = useState(initialTarget?.retry ?? '')
  const [cb, setCb] = useState(initialTarget?.circuitBreaker ?? '')
  const [scope, setScope] = useState<'' | 'type' | 'id' | 'both'>(initialTarget?.circuitBreakerScope ?? '')
  const [cacheSize, setCacheSize] = useState(initialTarget?.circuitBreakerCacheSize?.toString() ?? '')
  const nameOk = validateResourceName(name) === null
  const anyPolicy = !!(timeoutRef || retry || cb)
  const cacheOk = integerError(cacheSize) === null
  function save() {
    const t: ActorTarget = {}
    if (timeoutRef) t.timeout = timeoutRef
    if (retry) t.retry = retry
    if (cb) {
      t.circuitBreaker = cb
      if (scope) t.circuitBreakerScope = scope
      if (cacheSize) t.circuitBreakerCacheSize = Number(cacheSize)
    }
    onSave(name, t)
  }
  return (
    <Shell open={open} title={editing ? 'Edit actor target' : 'Add actor target'} onClose={onClose} canSave={nameOk && anyPolicy && cacheOk} onSave={save}>
      <Field label="Actor type" required error={name === '' ? null : validateResourceName(name)}>
        <TextInput aria-label="Actor type" value={name} onChange={setName} />
      </Field>
      <PolicyPickers policies={policies} timeout={timeoutRef} retry={retry} cb={cb} setTimeout={setTimeoutRef} setRetry={setRetry} setCb={setCb} />
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

export function ComponentTargetDialog({ open, policies, initialName, initialTarget, editing, onClose, onSave }: {
  open: boolean; policies: PolicyNames; initialName?: string; initialTarget?: ComponentTarget; editing?: boolean; onClose: () => void; onSave: (name: string, target: ComponentTarget) => void
}) {
  const hasOut = !!initialTarget?.outbound
  const hasIn = !!initialTarget?.inbound
  const initialDirection: 'outbound' | 'inbound' | 'both' = hasOut && hasIn ? 'both' : hasIn ? 'inbound' : 'outbound'
  const initialLeg = initialTarget?.outbound ?? initialTarget?.inbound
  const [name, setName] = useState(initialName ?? '')
  const [direction, setDirection] = useState<'outbound' | 'inbound' | 'both'>(initialDirection)
  const [timeoutRef, setTimeoutRef] = useState(initialLeg?.timeout ?? '')
  const [retry, setRetry] = useState(initialLeg?.retry ?? '')
  const [cb, setCb] = useState(initialLeg?.circuitBreaker ?? '')
  const nameOk = validateResourceName(name) === null
  const anyPolicy = !!(timeoutRef || retry || cb)
  function leg() {
    const l: { timeout?: string; retry?: string; circuitBreaker?: string } = {}
    if (timeoutRef) l.timeout = timeoutRef
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
    <Shell open={open} title={editing ? 'Edit component target' : 'Add component target'} onClose={onClose} canSave={nameOk && anyPolicy} onSave={save}>
      <Field label="Component name" required error={name === '' ? null : validateResourceName(name)}>
        <TextInput aria-label="Component name" value={name} onChange={setName} />
      </Field>
      <Field label="Direction" required>
        <SelectInput aria-label="Direction" value={direction}
          options={[{ label: 'outbound', value: 'outbound' }, { label: 'inbound', value: 'inbound' }, { label: 'both', value: 'both' }]}
          onChange={(v) => setDirection(v === 'inbound' ? 'inbound' : v === 'both' ? 'both' : 'outbound')} />
      </Field>
      <PolicyPickers policies={policies} timeout={timeoutRef} retry={retry} cb={cb} setTimeout={setTimeoutRef} setRetry={setRetry} setCb={setCb} />
    </Shell>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/pages/resiliency-builder/targetDialogs.test.tsx`
Expected: PASS (existing add-mode tests still pass).

- [ ] **Step 5: Typecheck and commit**

```bash
cd web && npx tsc -b
git add web/src/pages/resiliency-builder/targetDialogs.tsx web/src/pages/resiliency-builder/targetDialogs.test.tsx
git commit -m "feat(web): resiliency target dialogs gain edit mode + direction derivation"
```

---

## Task 7: StepPolicies — edit wiring, retries filter, overrides section

**Files:**
- Modify: `web/src/pages/resiliency-builder/StepPolicies.tsx`
- Test: `web/src/pages/resiliency-builder/steps.test.tsx`

**Interfaces:**
- Consumes: `NamedList` (Task 4), `TimeoutDialog`/`RetryDialog`/`CircuitBreakerDialog` (Task 5), `DEFAULT_DAPR_RETRY_POLICIES`/`isDefaultPolicyName`/`presetToRetryPolicy` (Task 2), `nextName`/`Action`/`ResiliencyState` (existing).
- Produces: `StepPolicies({ state, dispatch })` renders three editable lists (Retries list filters out `DaprBuiltIn*` keys) plus a "Default policy overrides" section with one row per built-in (Add or editable chip). Rename dispatches `REMOVE_*` + `UPSERT_*`.

- [ ] **Step 1: Write the failing tests**

In `steps.test.tsx`, add these tests inside the `describe('StepPolicies', ...)` block:

```ts
  it('edits an existing timeout via chip click (rename dispatches remove + upsert)', () => {
    const dispatch = vi.fn()
    const s = reducer(initialState(), { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    render(<StepPolicies state={s} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /edit timeout1/i }))
    fireEvent.change(screen.getByLabelText(/timeout name/i), { target: { value: 'renamed' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_TIMEOUT', name: 'timeout1' })
    expect(dispatch).toHaveBeenCalledWith({ type: 'UPSERT_TIMEOUT', name: 'renamed', duration: '30s' })
  })
  it('adds a DaprBuiltIn override with prefilled defaults', () => {
    const dispatch = vi.fn()
    render(<StepPolicies state={initialState()} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /add DaprBuiltInServiceRetries/i }))
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(dispatch).toHaveBeenCalledWith({
      type: 'UPSERT_RETRY',
      name: 'DaprBuiltInServiceRetries',
      policy: expect.objectContaining({ policy: 'constant', duration: '1s', maxRetries: 3 }),
    })
  })
  it('does not list a DaprBuiltIn override in the regular Retries list', () => {
    const dispatch = vi.fn()
    const s = reducer(initialState(), { type: 'UPSERT_RETRY', name: 'DaprBuiltInServiceRetries', policy: { policy: 'constant', duration: '1s', maxRetries: 3 } })
    render(<StepPolicies state={s} dispatch={dispatch} />)
    // present as an editable override chip, but not offered as an "Add" row anymore
    expect(screen.getByRole('button', { name: /edit DaprBuiltInServiceRetries/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add DaprBuiltInServiceRetries/i })).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/pages/resiliency-builder/steps.test.tsx`
Expected: FAIL — no edit wiring, no overrides section.

- [ ] **Step 3: Rewrite StepPolicies**

Replace `web/src/pages/resiliency-builder/StepPolicies.tsx` with:

```tsx
import { useState } from 'react'
import { NamedList } from './NamedList'
import { TimeoutDialog, RetryDialog, CircuitBreakerDialog } from './policyDialogs'
import { DEFAULT_DAPR_RETRY_POLICIES, isDefaultPolicyName, presetToRetryPolicy } from './defaultPolicies'
import { nextName, type Action, type ResiliencyState } from './reducer'

type Dialog =
  | null
  | { kind: 'timeout' | 'retry' | 'cb'; editName?: string }
  | { kind: 'override'; label: string; editing: boolean }

export function StepPolicies({ state, dispatch }: { state: ResiliencyState; dispatch: (a: Action) => void }) {
  const [open, setOpen] = useState<Dialog>(null)
  const pol = state.config.spec.policies
  const customRetryNames = Object.keys(pol.retries).filter((n) => !isDefaultPolicyName(n))

  function renameThenUpsert<A extends Action>(editName: string | undefined, name: string, removeType: Action['type'], upsert: A) {
    if (editName && editName !== name) dispatch({ type: removeType, name: editName } as Action)
    dispatch(upsert)
  }

  return (
    <div>
      <NamedList title="Timeouts" names={Object.keys(pol.timeouts)}
        onAdd={() => setOpen({ kind: 'timeout' })}
        onEdit={(name) => setOpen({ kind: 'timeout', editName: name })}
        onRemove={(name) => dispatch({ type: 'REMOVE_TIMEOUT', name })} />
      <NamedList title="Retries" names={customRetryNames}
        onAdd={() => setOpen({ kind: 'retry' })}
        onEdit={(name) => setOpen({ kind: 'retry', editName: name })}
        onRemove={(name) => dispatch({ type: 'REMOVE_RETRY', name })} />
      <NamedList title="Circuit breakers" names={Object.keys(pol.circuitBreakers)}
        onAdd={() => setOpen({ kind: 'cb' })}
        onEdit={(name) => setOpen({ kind: 'cb', editName: name })}
        onRemove={(name) => dispatch({ type: 'REMOVE_CB', name })} />

      <div className="sbsection">
        <div className="sech">Default policy overrides</div>
        <p className="none" style={{ marginTop: 0 }}>⚠ These override Dapr's built-in retry behavior globally.</p>
        {DEFAULT_DAPR_RETRY_POLICIES.map((preset) => {
          const exists = pol.retries[preset.label] !== undefined
          return exists ? (
            <div key={preset.label} className="chip k" style={{ marginRight: 6, marginBottom: 6 }}>
              <button type="button" aria-label={`Edit ${preset.label}`}
                onClick={() => setOpen({ kind: 'override', label: preset.label, editing: true })}
                style={{ background: 'none', border: 0, cursor: 'pointer', font: 'inherit', padding: 0 }}>
                <b>{preset.label}</b>
              </button>
              <button type="button" className="copybtn" aria-label={`Remove ${preset.label}`}
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'REMOVE_RETRY', name: preset.label }) }}>✕</button>
            </div>
          ) : (
            <div key={preset.label} className="sech" style={{ fontWeight: 'normal' }}>
              {preset.label}
              <button type="button" className="btn ghost" style={{ marginLeft: 'auto' }}
                aria-label={`Add ${preset.label}`} onClick={() => setOpen({ kind: 'override', label: preset.label, editing: false })}>
                + Add
              </button>
            </div>
          )
        })}
      </div>

      {open?.kind === 'timeout' && (
        <TimeoutDialog open editing={!!open.editName}
          initialName={open.editName ?? nextName('timeout', pol.timeouts)}
          initialDuration={open.editName ? pol.timeouts[open.editName] : undefined}
          onClose={() => setOpen(null)}
          onSave={(name, duration) => { renameThenUpsert(open.editName, name, 'REMOVE_TIMEOUT', { type: 'UPSERT_TIMEOUT', name, duration }); setOpen(null) }} />
      )}
      {open?.kind === 'retry' && (
        <RetryDialog open editing={!!open.editName}
          initialName={open.editName ?? nextName('retry', pol.retries)}
          initialPolicy={open.editName ? pol.retries[open.editName] : undefined}
          onClose={() => setOpen(null)}
          onSave={(name, policy) => { renameThenUpsert(open.editName, name, 'REMOVE_RETRY', { type: 'UPSERT_RETRY', name, policy }); setOpen(null) }} />
      )}
      {open?.kind === 'cb' && (
        <CircuitBreakerDialog open editing={!!open.editName}
          initialName={open.editName ?? nextName('circuitBreaker', pol.circuitBreakers)}
          initialPolicy={open.editName ? pol.circuitBreakers[open.editName] : undefined}
          onClose={() => setOpen(null)}
          onSave={(name, policy) => { renameThenUpsert(open.editName, name, 'REMOVE_CB', { type: 'UPSERT_CB', name, policy }); setOpen(null) }} />
      )}
      {open?.kind === 'override' && (
        <RetryDialog open lockName keepDurationForExponential editing={open.editing}
          initialName={open.label}
          initialPolicy={open.editing ? pol.retries[open.label] : presetToRetryPolicy(DEFAULT_DAPR_RETRY_POLICIES.find((p) => p.label === open.label)!)}
          onClose={() => setOpen(null)}
          onSave={(_name, policy) => { dispatch({ type: 'UPSERT_RETRY', name: open.label, policy }); setOpen(null) }} />
      )}
    </div>
  )
}
```

Note: `renameThenUpsert`'s `upsert` argument is the fully-typed action; the `removeType` cast is confined to the helper. If `npx tsc -b` rejects the generic cast, inline the rename check per dialog instead (three `if (editName && editName !== name) dispatch({ type: 'REMOVE_*', name: editName })` lines).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/pages/resiliency-builder/steps.test.tsx`
Expected: PASS (existing add/second-add/remove tests still pass).

- [ ] **Step 5: Typecheck and commit**

```bash
cd web && npx tsc -b
git add web/src/pages/resiliency-builder/StepPolicies.tsx web/src/pages/resiliency-builder/steps.test.tsx
git commit -m "feat(web): StepPolicies editable chips, retries filter, DaprBuiltIn overrides section"
```

---

## Task 8: StepTargets — edit wiring

**Files:**
- Modify: `web/src/pages/resiliency-builder/StepTargets.tsx`
- Test: `web/src/pages/resiliency-builder/steps.test.tsx`

**Interfaces:**
- Consumes: `NamedList` (Task 4), target dialogs (Task 6), `Action`/`ResiliencyState`/`PolicyNames` (existing).
- Produces: `StepTargets({ state, dispatch })` with editable app/actor/component chips; rename dispatches `REMOVE_*` + `UPSERT_*`.

- [ ] **Step 1: Write the failing test**

In `steps.test.tsx`, add a new describe block (and add `StepTargets` to the imports at the top):

```ts
import { StepTargets } from './StepTargets'
```

```ts
describe('StepTargets', () => {
  it('edits an existing app target via chip click', () => {
    const dispatch = vi.fn()
    let s = reducer(initialState(), { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    s = reducer(s, { type: 'UPSERT_APP', name: 'orders', target: { timeout: 'timeout1' } })
    render(<StepTargets state={s} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /edit orders/i }))
    expect((screen.getByLabelText(/app id/i) as HTMLInputElement).value).toBe('orders')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'UPSERT_APP', name: 'orders', target: expect.objectContaining({ timeout: 'timeout1' }) })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/resiliency-builder/steps.test.tsx`
Expected: FAIL — no `Edit orders` button.

- [ ] **Step 3: Rewrite StepTargets**

Replace `web/src/pages/resiliency-builder/StepTargets.tsx` with:

```tsx
import { useState } from 'react'
import { NamedList } from './NamedList'
import { AppTargetDialog, ActorTargetDialog, ComponentTargetDialog, type PolicyNames } from './targetDialogs'
import { type Action, type ResiliencyState } from './reducer'

type Dialog = null | { kind: 'app' | 'actor' | 'component'; editName?: string }

export function StepTargets({ state, dispatch }: { state: ResiliencyState; dispatch: (a: Action) => void }) {
  const [open, setOpen] = useState<Dialog>(null)
  const { policies, targets } = state.config.spec
  const names: PolicyNames = {
    timeouts: Object.keys(policies.timeouts),
    retries: Object.keys(policies.retries),
    circuitBreakers: Object.keys(policies.circuitBreakers),
  }
  const apps = targets.apps ?? {}
  const actors = targets.actors ?? {}
  const components = targets.components ?? {}

  return (
    <div>
      <NamedList title="Apps" names={Object.keys(apps)}
        onAdd={() => setOpen({ kind: 'app' })}
        onEdit={(name) => setOpen({ kind: 'app', editName: name })}
        onRemove={(name) => dispatch({ type: 'REMOVE_APP', name })} />
      <NamedList title="Actors" names={Object.keys(actors)}
        onAdd={() => setOpen({ kind: 'actor' })}
        onEdit={(name) => setOpen({ kind: 'actor', editName: name })}
        onRemove={(name) => dispatch({ type: 'REMOVE_ACTOR', name })} />
      <NamedList title="Components" names={Object.keys(components)}
        onAdd={() => setOpen({ kind: 'component' })}
        onEdit={(name) => setOpen({ kind: 'component', editName: name })}
        onRemove={(name) => dispatch({ type: 'REMOVE_COMPONENT', name })} />

      {open?.kind === 'app' && (
        <AppTargetDialog open policies={names} editing={!!open.editName}
          initialName={open.editName} initialTarget={open.editName ? apps[open.editName] : undefined}
          onClose={() => setOpen(null)}
          onSave={(name, target) => { if (open.editName && open.editName !== name) dispatch({ type: 'REMOVE_APP', name: open.editName }); dispatch({ type: 'UPSERT_APP', name, target }); setOpen(null) }} />
      )}
      {open?.kind === 'actor' && (
        <ActorTargetDialog open policies={names} editing={!!open.editName}
          initialName={open.editName} initialTarget={open.editName ? actors[open.editName] : undefined}
          onClose={() => setOpen(null)}
          onSave={(name, target) => { if (open.editName && open.editName !== name) dispatch({ type: 'REMOVE_ACTOR', name: open.editName }); dispatch({ type: 'UPSERT_ACTOR', name, target }); setOpen(null) }} />
      )}
      {open?.kind === 'component' && (
        <ComponentTargetDialog open policies={names} editing={!!open.editName}
          initialName={open.editName} initialTarget={open.editName ? components[open.editName] : undefined}
          onClose={() => setOpen(null)}
          onSave={(name, target) => { if (open.editName && open.editName !== name) dispatch({ type: 'REMOVE_COMPONENT', name: open.editName }); dispatch({ type: 'UPSERT_COMPONENT', name, target }); setOpen(null) }} />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/resiliency-builder/steps.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd web && npx tsc -b
git add web/src/pages/resiliency-builder/StepTargets.tsx web/src/pages/resiliency-builder/steps.test.tsx
git commit -m "feat(web): StepTargets editable target chips"
```

---

## Task 9: End-to-end — overrides-only config reaches preview

**Files:**
- Test: `web/src/pages/resiliency-builder/ResiliencyBuilder.test.tsx`

**Interfaces:**
- Consumes: `ResiliencyBuilder` page (existing), full wizard flow.
- Produces: no source change — this task guards the integrated behaviour (override-only path + default namespace).

- [ ] **Step 1: Write the failing test**

In `ResiliencyBuilder.test.tsx`, add this test inside the `describe('ResiliencyBuilder', ...)` block:

```ts
  it('finishes with only a DaprBuiltIn override (no explicit target) and emits default namespace', async () => {
    renderBuilder()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'my-res' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 0->1
    fireEvent.click(screen.getByRole('button', { name: /add DaprBuiltInServiceRetries/i }))
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 1->2 (policy present)
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 2->3 (override satisfies gating)
    await waitFor(() => expect(document.querySelector('pre.code')?.textContent).toContain('kind: Resiliency'))
    const yaml = document.querySelector('pre.code')?.textContent ?? ''
    expect(yaml).toContain('namespace: default')
    expect(yaml).toContain('DaprBuiltInServiceRetries')
  })
```

- [ ] **Step 2: Run the test to verify it passes (behaviour already built in Tasks 1-8)**

Run: `cd web && npx vitest run src/pages/resiliency-builder/ResiliencyBuilder.test.tsx`
Expected: PASS. If it fails on the second `continue` being disabled, confirm Task 3 gating landed; if it fails on `namespace: default`, confirm Task 1 landed.

- [ ] **Step 3: Full resiliency-builder test sweep + typecheck**

Run:
```bash
cd web && npx tsc -b && npx vitest run src/pages/resiliency-builder
```
Expected: all resiliency-builder tests PASS, no type errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/resiliency-builder/ResiliencyBuilder.test.tsx
git commit -m "test(web): e2e override-only resiliency config with default namespace"
```

---

## Self-Review

**Spec coverage:**
- §1 namespace `default` → Task 1 (type default + emit tests). ✓
- §2 real defaults (timeout `5s`; CB `maxRequests 1`/`timeout 45s`/`trip`/`interval 8s`) → Task 5. ✓
- §3 editable chips (NamedList `onEdit`; all six dialogs edit mode; rename; component direction) → Tasks 4, 5, 6, 7, 8. ✓
- §4 overrides (presets module; overrides section; retries filter; exponential `duration` preservation; override-aware gating) → Tasks 2, 3, 5 (`keepDurationForExponential`), 7. ✓
- Testing section → each task is TDD; Task 9 integrates. ✓
- Non-goals (no read-only Targets table, no ResiliencyAccess) → not built. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has an expected result. ✓

**Type consistency:**
- `onEdit?: (name: string) => void` — defined Task 4, consumed Tasks 7, 8. ✓
- Dialog prop names (`initialDuration`, `initialPolicy`, `initialTarget`, `editing`, `lockName`, `keepDurationForExponential`) — defined Tasks 5, 6; consumed Tasks 7, 8. ✓
- `DEFAULT_DAPR_RETRY_POLICIES`, `isDefaultPolicyName`, `presetToRetryPolicy`, `DefaultPolicyPreset` — defined Task 2; consumed Tasks 3, 7. ✓
- `UPSERT_*`/`REMOVE_*` action names match the existing reducer (unchanged). ✓
- `canContinue` case 2 signature unchanged; only body edited (Task 3). ✓
