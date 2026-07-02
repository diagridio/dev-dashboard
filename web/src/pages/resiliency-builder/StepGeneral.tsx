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
      <Field label="Namespace">
        <TextInput id="r-ns" value={state.config.metadata.namespace ?? ''} onChange={(v) => dispatch({ type: 'SET_NAMESPACE', namespace: v })} />
      </Field>
    </div>
  )
}
