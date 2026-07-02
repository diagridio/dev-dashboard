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
