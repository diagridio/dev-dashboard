import { Fragment } from 'react'

interface StepperProps {
  steps: { label: string }[]
  activeStep: number
}

export function Stepper({ steps, activeStep }: StepperProps) {
  return (
    <div className="stepper" role="list" aria-label="Wizard steps">
      {steps.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && (
            <span className="step-arrow" aria-hidden="true">
              →
            </span>
          )}
          <span
            role="listitem"
            aria-current={i === activeStep ? 'step' : undefined}
            className={`step${i === activeStep ? ' active' : ''}${i < activeStep ? ' done' : ''}`}
          >
            {s.label}
          </span>
        </Fragment>
      ))}
    </div>
  )
}
