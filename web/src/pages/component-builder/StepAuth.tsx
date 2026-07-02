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
