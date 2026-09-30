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

  it('always shows the execution ID after a game, with the standard copy button behind it', () => {
    const onCopy = vi.fn()
    const { rerender } = render(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} executionId="RPL1.abc" onCopyExecutionId={onCopy} />)
    const field = screen.getByRole('textbox', { name: 'Execution ID' }) as HTMLInputElement
    expect(field).toHaveAttribute('readonly')
    expect(field.value).toBe('RPL1.abc')
    const copy = screen.getByRole('button', { name: 'Copy execution ID' })
    expect(copy).toHaveClass('copybtn')
    expect(copy).toHaveTextContent('⧉ Copy')
    // The copy button sits right behind the field.
    expect(field.nextElementSibling).toBe(copy)
    fireEvent.click(copy)
    expect(onCopy).toHaveBeenCalledTimes(1)
    rerender(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} executionId="RPL1.abc" onCopyExecutionId={onCopy} idCopied />)
    expect(screen.getByRole('button', { name: 'Copy execution ID' })).toHaveClass('ok')
    expect(screen.getByRole('button', { name: 'Copy execution ID' })).toHaveTextContent('✓ Copied')
    // A playback's end card shows the ID of the run it played.
    rerender(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} executionId="RPL1.abc" onCopyExecutionId={onCopy} playback />)
    expect(screen.getByRole('heading', { name: 'Playback finished' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Execution ID' })).toHaveValue('RPL1.abc')
  })

  it('selects the whole execution ID when the field is focused, for a manual copy', () => {
    render(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} executionId="RPL1.abcdef" onCopyExecutionId={vi.fn()} />)
    const field = screen.getByRole('textbox', { name: 'Execution ID' }) as HTMLInputElement
    fireEvent.focus(field)
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'RPL1.abcdef'.length])
  })

  it('says the execution ID is being created, or why it could not be', () => {
    const { rerender } = render(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} />)
    expect(screen.getByText('Creating the execution ID…')).toBeInTheDocument()
    rerender(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} executionIdError="This run is too long to share." />)
    expect(screen.getByText('This run is too long to share.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Execution ID' })).toBeNull()
  })

  it('offers Replay entire run instead of Copy run code, in live runs and playbacks', () => {
    const onReplayRun = vi.fn()
    const { rerender } = render(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onShare={vi.fn()} onReplayRun={onReplayRun} />)
    expect(screen.queryByRole('button', { name: /Copy run code/ })).toBeNull()
    const replay = screen.getByRole('button', { name: 'Replay entire run' })
    expect(replay).toHaveClass('tbtn')
    fireEvent.click(replay)
    expect(onReplayRun).toHaveBeenCalledTimes(1)
    rerender(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onReplayRun={onReplayRun} playback />)
    expect(screen.getByRole('button', { name: 'Replay entire run' })).toBeInTheDocument()
  })

  it('explains on the title card that a run is replayed from an execution ID someone shared or you copied', () => {
    const onWatch = vi.fn()
    render(<Overlay phase={{ kind: 'title' }} {...common} onWatch={onWatch} watchError="That execution ID isn't valid." />)
    expect(screen.getByText(/Replay a run from its execution ID/)).toHaveTextContent(
      'Replay a run from its execution ID: one someone shared with you, or one you copied after an earlier run.',
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Execution ID' }), { target: { value: ' RPL1.xyz ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Replay run' }))
    expect(onWatch).toHaveBeenCalledWith(' RPL1.xyz ')
    expect(screen.getByText("That execution ID isn't valid.")).toBeInTheDocument()
    expect(screen.queryByText(/run code/i)).toBeNull()
  })

  it('sets the daily run, the instructions and the best scores larger on the start card', () => {
    render(<Overlay phase={{ kind: 'title' }} {...common} dailyBest={7} />)
    for (const text of ['Daily run · 2026-09-30 (UTC)', 'Space / ↑ jump (hold for higher) · ↓ slide · Esc pause', "Today's best: 7 · Best: 40"]) {
      expect(screen.getByText(text)).toHaveClass('replay-keys', 'replay-start-meta')
    }
  })

  it('keeps the smaller key hints on the other cards', () => {
    render(<Overlay phase={{ kind: 'paused' }} {...common} />)
    expect(screen.getByText('Esc or Enter to continue')).not.toHaveClass('replay-start-meta')
  })

  it('documents variable jump height in the title-card key hint', () => {
    render(<Overlay phase={{ kind: 'title' }} {...common} />)
    expect(screen.getByText('Space / ↑ jump (hold for higher) · ↓ slide · Esc pause')).toBeInTheDocument()
  })
})
