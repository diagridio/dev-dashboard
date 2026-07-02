interface StepperProps {
  steps: { label: string }[]
  activeStep: number
}

export function Stepper({ steps, activeStep }: StepperProps) {
  return (
    <div className="stepper" role="list" aria-label="Wizard steps">
      {steps.map((s, i) => (
        <span
          key={s.label}
          role="listitem"
          aria-current={i === activeStep ? 'step' : undefined}
          className={`step${i === activeStep ? ' active' : ''}${i < activeStep ? ' done' : ''}`}
        >
          {s.label}
        </span>
      ))}
    </div>
  )
}
