import { useMemo, useReducer } from 'react'
import { useNavigate } from 'react-router-dom'
import { Wizard, type WizardStep } from '../../components/wizard'
import { YamlPreview } from '../../components/YamlPreview'
import { dumpYaml } from '../../lib/yaml-emit'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { initialState, reducer, canContinue, assembleResiliency } from './reducer'
import { StepGeneral } from './StepGeneral'
import { StepPolicies } from './StepPolicies'
import { StepTargets } from './StepTargets'

export function ResiliencyBuilder() {
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(reducer, undefined, initialState)

  useDocumentTitle('New resiliency policy')

  const yaml = useMemo(
    () => (state.activeStep === 3 ? dumpYaml(assembleResiliency(state.config)) : ''),
    [state],
  )

  const steps: WizardStep[] = [
    { label: 'General', content: <StepGeneral state={state} dispatch={dispatch} /> },
    { label: 'Policies', content: <StepPolicies state={state} dispatch={dispatch} /> },
    { label: 'Targets', content: <StepTargets state={state} dispatch={dispatch} /> },
    { label: 'Preview', content: <YamlPreview yaml={yaml} filename={`${state.config.metadata.name || 'resiliency'}.yaml`} /> },
  ]

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>New resiliency policy</h1>
          <div className="sub">Build a Dapr resiliency YAML to copy or download</div>
        </div>
        <button type="button" className="btn ghost" onClick={() => navigate('/resiliency')}>Cancel</button>
      </div>
      <div className="card" style={{ padding: 18 }}>
        <Wizard
          steps={steps}
          activeStep={state.activeStep}
          canContinue={canContinue(state)}
          onBack={() => dispatch({ type: 'BACK' })}
          onContinue={() => dispatch({ type: 'NEXT' })}
          onFinish={() => navigate('/resiliency')}
        />
      </div>
    </div>
  )
}
