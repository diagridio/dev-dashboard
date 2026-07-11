interface StepNavProps {
  activeStep: number
  stepCount: number
  canContinue: boolean
  onBack: () => void
  onContinue: () => void
  onFinish: () => void
}

export function StepNav({ activeStep, stepCount, canContinue, onBack, onContinue, onFinish }: StepNavProps) {
  const isLast = activeStep === stepCount - 1
  return (
    <div className="stepnav">
      {activeStep > 0 ? (
        <button type="button" className="btn ghost" onClick={onBack}>Back</button>
      ) : (
        <span className="spacer" />
      )}
      {isLast ? (
        <button type="button" className="btn primary" disabled={!canContinue} onClick={onFinish}>Finish</button>
      ) : (
        <button type="button" className="btn primary" disabled={!canContinue} onClick={onContinue}>Continue</button>
      )}
    </div>
  )
}
