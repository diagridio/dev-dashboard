import { useState } from 'react'
import { NamedList } from './NamedList'
import { AppTargetDialog, ActorTargetDialog, ComponentTargetDialog, type PolicyNames } from './targetDialogs'
import { upsertWithRename, type Action, type ResiliencyState } from './reducer'

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
        <AppTargetDialog open policies={names} editing={!!open.editName} existingNames={Object.keys(apps)}
          initialName={open.editName} initialTarget={open.editName ? apps[open.editName] : undefined}
          onClose={() => setOpen(null)}
          onSave={(name, target) => { upsertWithRename(dispatch, open.editName, name, (from) => ({ type: 'REMOVE_APP', name: from }), { type: 'UPSERT_APP', name, target }); setOpen(null) }} />
      )}
      {open?.kind === 'actor' && (
        <ActorTargetDialog open policies={names} editing={!!open.editName} existingNames={Object.keys(actors)}
          initialName={open.editName} initialTarget={open.editName ? actors[open.editName] : undefined}
          onClose={() => setOpen(null)}
          onSave={(name, target) => { upsertWithRename(dispatch, open.editName, name, (from) => ({ type: 'REMOVE_ACTOR', name: from }), { type: 'UPSERT_ACTOR', name, target }); setOpen(null) }} />
      )}
      {open?.kind === 'component' && (
        <ComponentTargetDialog open policies={names} editing={!!open.editName} existingNames={Object.keys(components)}
          initialName={open.editName} initialTarget={open.editName ? components[open.editName] : undefined}
          onClose={() => setOpen(null)}
          onSave={(name, target) => { upsertWithRename(dispatch, open.editName, name, (from) => ({ type: 'REMOVE_COMPONENT', name: from }), { type: 'UPSERT_COMPONENT', name, target }); setOpen(null) }} />
      )}
    </div>
  )
}
