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
        <TextInput id="c-name" value={state.name} onChange={(v) => dispatch({ type: 'SET_NAME', name: v })} />
      </Field>
      <Field label="Resource namespace" htmlFor="c-ns">
        <TextInput id="c-ns" value={state.namespace} onChange={(v) => dispatch({ type: 'SET_NAMESPACE', namespace: v })} />
      </Field>

      <div className="sec-title">Metadata</div>
      {shown.map((f) => {
        const useSecret = !!state.useSecret[f.name]
        const ref = state.secretRefs[f.name] ?? { name: '', key: '' }
        return (
          <Field key={f.name} label={f.name} required={f.required}>
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
            value=""
            options={notAdded.map((f) => ({ label: f.name, value: f.name }))}
            onChange={(field) => field && dispatch({ type: 'ADD_OPTIONAL', field })}
          />
        </Field>
      )}
    </div>
  )
}
