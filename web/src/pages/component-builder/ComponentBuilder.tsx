import { useMemo, useReducer, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Wizard, type WizardStep } from '../../components/wizard'
import { YamlPreview } from '../../components/YamlPreview'
import { dumpYaml } from '../../lib/yaml-emit'
import { initialState, reducer, canContinue, assembleComponentSpec } from './reducer'
import { StepType } from './StepType'
import { StepAuth } from './StepAuth'
import { StepConfigure } from './StepConfigure'

export function ComponentBuilder() {
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const [previewEdited, setPreviewEdited] = useState(false)

  const yaml = useMemo(
    () => (state.activeStep === 3 ? dumpYaml(assembleComponentSpec(state)) : ''),
    [state],
  )

  const steps: WizardStep[] = [
    { label: 'Type', content: <StepType state={state} dispatch={dispatch} /> },
    { label: 'Auth', content: <StepAuth state={state} dispatch={dispatch} /> },
    { label: 'Configure', content: <StepConfigure state={state} dispatch={dispatch} /> },
    {
      label: 'Preview',
      content: (
        <YamlPreview yaml={yaml} filename={`${state.name || 'component'}.yaml`} onEditedChange={setPreviewEdited} />
      ),
    },
  ]

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>New component</h1>
          <div className="sub">Build a Dapr component YAML to copy or download</div>
        </div>
        <button type="button" className="btn ghost" onClick={() => navigate('/components')}>Cancel</button>
      </div>
      <div className="card" style={{ padding: 18 }}>
        <Wizard
          steps={steps}
          activeStep={state.activeStep}
          canContinue={state.activeStep === 3 ? !previewEdited : canContinue(state)}
          onBack={() => dispatch({ type: 'BACK' })}
          onContinue={() => dispatch({ type: 'NEXT' })}
          onFinish={() => navigate('/components')}
        />
      </div>
    </div>
  )
}
