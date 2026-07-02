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
        <p className="none" style={{ marginTop: 0 }}>&#9888; These override Dapr's built-in retry behavior globally.</p>
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
                onClick={(e) => { e.stopPropagation(); dispatch({ type: 'REMOVE_RETRY', name: preset.label }) }}>&#x2715;</button>
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
