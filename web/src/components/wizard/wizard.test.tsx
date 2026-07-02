import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Wizard, StepNav } from './index'

const steps = [
  { label: 'One', content: <div>content-one</div> },
  { label: 'Two', content: <div>content-two</div> },
]

describe('Wizard', () => {
  it('renders step labels and only the active step content', () => {
    render(<Wizard steps={steps} activeStep={0} canContinue onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.getByText('Two')).toBeInTheDocument()
    expect(screen.getByText('content-one')).toBeInTheDocument()
    expect(screen.queryByText('content-two')).not.toBeInTheDocument()
  })
})

describe('StepNav', () => {
  it('hides Back on the first step and shows Continue', () => {
    render(<StepNav activeStep={0} stepCount={2} canContinue onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    expect(screen.queryByRole('button', { name: /back/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled()
  })
  it('shows Finish (not Continue) on the last step', () => {
    render(<StepNav activeStep={1} stepCount={2} canContinue onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    expect(screen.getByRole('button', { name: /finish/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /continue/i })).not.toBeInTheDocument()
  })
  it('disables the primary action when canContinue is false', () => {
    render(<StepNav activeStep={0} stepCount={2} canContinue={false} onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()
  })
  it('primary button uses ghost styling, never the green .btn.primary', () => {
    render(<StepNav activeStep={0} stepCount={2} canContinue onBack={() => {}} onContinue={() => {}} onFinish={() => {}} />)
    const cont = screen.getByRole('button', { name: /continue/i })
    expect(cont).toHaveClass('btn', 'ghost')
    expect(cont).not.toHaveClass('primary')
    expect(cont).not.toHaveClass('mono')
  })
  it('fires onContinue / onFinish / onBack', () => {
    const onContinue = vi.fn(); const onFinish = vi.fn(); const onBack = vi.fn()
    const { rerender } = render(<StepNav activeStep={0} stepCount={2} canContinue onBack={onBack} onContinue={onContinue} onFinish={onFinish} />)
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(onContinue).toHaveBeenCalledOnce()
    rerender(<StepNav activeStep={1} stepCount={2} canContinue onBack={onBack} onContinue={onContinue} onFinish={onFinish} />)
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    fireEvent.click(screen.getByRole('button', { name: /finish/i }))
    expect(onBack).toHaveBeenCalledOnce()
    expect(onFinish).toHaveBeenCalledOnce()
  })
})
