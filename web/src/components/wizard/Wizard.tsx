import { Stepper } from './Stepper'
import { StepNav } from './StepNav'

export interface WizardStep {
  label: string
  content: React.ReactNode
}

interface WizardProps {
  steps: WizardStep[]
  activeStep: number
  canContinue: boolean
  onBack: () => void
  onContinue: () => void
  onFinish: () => void
}

export function Wizard({ steps, activeStep, canContinue, onBack, onContinue, onFinish }: WizardProps) {
  return (
    <div className="wizard">
      <Stepper steps={steps.map((s) => ({ label: s.label }))} activeStep={activeStep} />
      <div className="wizard-body">{steps[activeStep]?.content}</div>
      <StepNav
        activeStep={activeStep}
        stepCount={steps.length}
        canContinue={canContinue}
        onBack={onBack}
        onContinue={onContinue}
        onFinish={onFinish}
      />
    </div>
  )
}
