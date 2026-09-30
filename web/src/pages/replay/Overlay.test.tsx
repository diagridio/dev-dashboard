import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Overlay } from './Overlay'

const stats = { replays: 2, fromHistory: 5, executed: 9, incidents: 1 }

describe('Overlay', () => {
  it('shows the level reached on the end-of-run card', () => {
    render(<Overlay phase={{ kind: 'over', reason: 'hit an obstacle' }} stats={stats} best={40} score={12} level={3} />)
    const level = screen.getByText('Level')
    expect(level.previousElementSibling).toHaveTextContent('3')
  })

  it('offers a Share button on the end-of-run card', () => {
    const onShare = vi.fn()
    render(
      <Overlay phase={{ kind: 'over', reason: 'hit an obstacle' }} stats={stats} best={40} score={12} level={3} onShare={onShare} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '↗ Share' }))
    expect(onShare).toHaveBeenCalledTimes(1)
  })

  it('styles the Share button like the top-nav one and puts it on the Enter hint row', () => {
    render(
      <Overlay phase={{ kind: 'over', reason: 'hit an obstacle' }} stats={stats} best={40} score={12} level={3} onShare={vi.fn()} />,
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
    render(<Overlay phase={{ kind: 'title' }} stats={stats} best={40} score={12} level={0} onShare={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '↗ Share' })).toBeNull()
  })
})
