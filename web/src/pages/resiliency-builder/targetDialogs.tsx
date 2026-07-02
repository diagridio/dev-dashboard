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
