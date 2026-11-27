import { act, render, renderHook, screen } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useToast, Toast, ToastProvider } from './toast'

// Helper component that exposes the toast API for testing
function ToastHarness({ onMount }: { onMount: (show: (msg: string) => void) => void }) {
  const { toast, toastNode } = useToast()
  // expose show via callback on first render
  onMount(toast.show)
  return <>{toastNode}</>
}

describe('Toast component', () => {
  it('renders with aria-live="polite"', () => {
    const { container } = render(<Toast msg={null} />)
    const toastEl = container.querySelector('[aria-live="polite"]')
    expect(toastEl).not.toBeNull()
    expect(toastEl).toHaveAttribute('aria-live', 'polite')
  })

  it('has no "show" class when msg is null', () => {
    const { container } = render(<Toast msg={null} />)
    const toastEl = container.querySelector('.toast')
    expect(toastEl).not.toHaveClass('show')
  })

  it('has "show" class and renders message text when msg is set', () => {
    const { container } = render(<Toast msg="Copied!" />)
    const toastEl = container.querySelector('.toast')
    expect(toastEl).toHaveClass('show')
    expect(screen.getByText('Copied!')).toBeInTheDocument()
  })
})

describe('useToast hook', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows message on toast.show() call', () => {
    let showFn: ((msg: string) => void) | null = null
    const { container } = render(
      <ToastHarness onMount={(fn) => { showFn = fn }} />,
    )

    // toast div should not have "show" class initially
    const toastEl = container.querySelector('.toast')!
    expect(toastEl).not.toHaveClass('show')

    // call show
    act(() => { showFn!('Path copied') })
    expect(toastEl).toHaveClass('show')
    expect(screen.getByText('Path copied')).toBeInTheDocument()
  })

  it('auto-hides after 1400ms', () => {
    vi.useFakeTimers()
    let showFn: ((msg: string) => void) | null = null
    const { container } = render(
      <ToastHarness onMount={(fn) => { showFn = fn }} />,
    )

    const toastEl = container.querySelector('.toast')!
    act(() => { showFn!('Copied!') })
    expect(toastEl).toHaveClass('show')

    act(() => { vi.advanceTimersByTime(1400) })
    expect(toastEl).not.toHaveClass('show')
  })

  it('returns a stable toast identity across re-renders', () => {
    const { result, rerender } = renderHook(() => useToast())
    const first = result.current.toast
    rerender()
    expect(result.current.toast).toBe(first)
  })

  it('toastNode has aria-live="polite"', () => {
    const { container } = render(<ToastHarness onMount={() => {}} />)
    const toastEl = container.querySelector('[aria-live="polite"]')
    expect(toastEl).not.toBeNull()
    expect(toastEl).toHaveAttribute('aria-live', 'polite')
  })
})

describe('ToastProvider', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('two components share one toast', () => {
    let showA: ((msg: string) => void) | null = null
    let showB: ((msg: string) => void) | null = null
    render(
      <ToastProvider>
        <ToastHarness onMount={(fn) => { showA = fn }} />
        <ToastHarness onMount={(fn) => { showB = fn }} />
      </ToastProvider>,
    )
    act(() => { showA!('A copied') })
    act(() => { showB!('B copied') })
    const toasts = document.querySelectorAll('.toast')
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toHaveClass('show')
    expect(toasts[0]).toHaveTextContent('B copied')
    expect(screen.queryByText('A copied')).toBeNull()
  })

  it('message outlives the caller', () => {
    vi.useFakeTimers()
    let show: ((msg: string) => void) | null = null
    function Host({ withCaller }: { withCaller: boolean }) {
      return (
        <ToastProvider>
          {withCaller && <ToastHarness onMount={(fn) => { show = fn }} />}
        </ToastProvider>
      )
    }
    const { rerender } = render(<Host withCaller />)
    act(() => { show!('X copied') })
    rerender(<Host withCaller={false} />)
    const toastEl = document.querySelector('.toast')!
    expect(toastEl).toHaveClass('show')
    expect(toastEl).toHaveTextContent('X copied')
    act(() => { vi.advanceTimersByTime(1400) })
    expect(toastEl).not.toHaveClass('show')
  })

  it('falls back without a provider', () => {
    let show: ((msg: string) => void) | null = null
    const { container } = render(<ToastHarness onMount={(fn) => { show = fn }} />)
    act(() => { show!('Local copied') })
    expect(container.querySelector('.toast')).toHaveTextContent('Local copied')
  })
})
