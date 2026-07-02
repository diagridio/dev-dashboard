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

      {open === 'timeout' && (
        <TimeoutDialog open initialName={nextName('timeout', pol.timeouts)} onClose={() => setOpen(null)}
          onSave={(name, duration) => { dispatch({ type: 'UPSERT_TIMEOUT', name, duration }); setOpen(null) }} />
      )}
      {open === 'retry' && (
        <RetryDialog open initialName={nextName('retry', pol.retries)} onClose={() => setOpen(null)}
          onSave={(name, policy) => { dispatch({ type: 'UPSERT_RETRY', name, policy }); setOpen(null) }} />
      )}
      {open === 'cb' && (
        <CircuitBreakerDialog open initialName={nextName('circuitBreaker', pol.circuitBreakers)} onClose={() => setOpen(null)}
          onSave={(name, policy) => { dispatch({ type: 'UPSERT_CB', name, policy }); setOpen(null) }} />
      )}
    </div>
  )
}
