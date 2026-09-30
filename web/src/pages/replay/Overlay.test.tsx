import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Overlay } from './Overlay'

const stats = { replays: 2, fromHistory: 5, executed: 9, incidents: 1, retriesUsed: 2, circuitTrips: 1, boostsLost: 3 }

describe('Overlay', () => {
  it('shows the level reached on the end-of-run card', () => {
    render(<Overlay phase={{ kind: 'over', reason: 'hit an obstacle' }} stats={stats} best={40} score={12} level={3} date="2026-09-30" dailyBest={0} />)
    const level = screen.getByText('Level')
    expect(level.previousElementSibling).toHaveTextContent('3')
  })

  it('offers a Share button on the end-of-run card', () => {
    const onShare = vi.fn()
    render(
      <Overlay phase={{ kind: 'over', reason: 'hit an obstacle' }} stats={stats} best={40} score={12} level={3} date="2026-09-30" dailyBest={0} onShare={onShare} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '↗ Share' }))
    expect(onShare).toHaveBeenCalledTimes(1)
  })

  it('styles the Share button like the top-nav one and puts it on the Enter hint row', () => {
    render(
      <Overlay phase={{ kind: 'over', reason: 'hit an obstacle' }} stats={stats} best={40} score={12} level={3} date="2026-09-30" dailyBest={0} onShare={vi.fn()} />,
    )
    const share = screen.getByRole('button', { name: '↗ Share' })
    expect(share).toHaveClass('tbtn')
    const hint = screen.getByText('Enter to play again')
    expect(share.parentElement).toBe(hint.parentElement)
    expect(share.parentElement).toHaveClass('replay-foot')
    // The hint comes first (left), the button last (right-aligned by the row).
    expect(share.parentElement?.lastElementChild).toBe(share)
  })

  it('shows no Share button outside the end-of-run card', () => {
    render(<Overlay phase={{ kind: 'title' }} stats={stats} best={40} score={12} level={0} date="2026-09-30" dailyBest={0} onShare={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '↗ Share' })).toBeNull()
  })

  it('shows the safety stats on the end-of-run card', () => {
    render(<Overlay phase={{ kind: 'over', reason: 'hit an obstacle' }} stats={stats} best={40} score={12} level={3} date="2026-09-30" dailyBest={0} />)
    expect(screen.getByText('Retries used').previousElementSibling).toHaveTextContent('2')
    expect(screen.getByText('Circuit trips').previousElementSibling).toHaveTextContent('1')
    expect(screen.getByText('Boosts lost').previousElementSibling).toHaveTextContent('3')
  })

  it("names today's daily run and shows today's best on the title card", () => {
    render(<Overlay phase={{ kind: 'title' }} stats={stats} best={40} score={0} level={0} date="2026-09-30" dailyBest={7} />)
    expect(screen.getByText('Daily run · 2026-09-30 (UTC)')).toBeInTheDocument()
    expect(screen.getByText("Today's best: 7 · Best: 40")).toBeInTheDocument()
  })

  const common = { stats, best: 40, score: 12, level: 3, date: '2026-09-30', dailyBest: 0 }

  it('offers Copy run code next to Share on the end-of-run card, but not in playback', () => {
    const onCopyRun = vi.fn()
    const { rerender } = render(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onShare={vi.fn()} onCopyRun={onCopyRun} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy run code' }))
    expect(onCopyRun).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Copy run code' })).toHaveClass('tbtn')
    rerender(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onCopyRun={onCopyRun} playback />)
    expect(screen.queryByRole('button', { name: 'Copy run code' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Playback finished' })).toBeInTheDocument()
  })

  it('confirms a copy, and shows the code pre-selected when it could not be copied', () => {
    const { rerender } = render(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onCopyRun={vi.fn()} copied />)
    expect(screen.getByRole('button', { name: '✓ Copied' })).toBeInTheDocument()
    rerender(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onCopyRun={vi.fn()} runCode="RPL1.abc" />)
    const box = screen.getByRole('textbox', { name: 'Run code' }) as HTMLTextAreaElement
    expect(box).toHaveAttribute('readonly')
    expect(box.value).toBe('RPL1.abc')
    expect(document.activeElement).toBe(box)
    expect(box.selectionStart).toBe(0)
    expect(box.selectionEnd).toBe('RPL1.abc'.length)
  })

  it('submits a pasted code from the title card and shows an error', () => {
    const onWatch = vi.fn()
    render(<Overlay phase={{ kind: 'title' }} {...common} onWatch={onWatch} watchError="That run code isn't valid." />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste a run code' }), { target: { value: ' RPL1.xyz ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Watch a run' }))
    expect(onWatch).toHaveBeenCalledWith(' RPL1.xyz ')
    expect(screen.getByText("That run code isn't valid.")).toBeInTheDocument()
  })

  it('documents variable jump height in the title-card key hint', () => {
    render(<Overlay phase={{ kind: 'title' }} {...common} />)
    expect(screen.getByText('Space / ↑ jump (hold for higher) · ↓ slide · Esc pause')).toBeInTheDocument()
  })
})
