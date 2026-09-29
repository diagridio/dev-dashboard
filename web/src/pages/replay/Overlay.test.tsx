import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Overlay } from './Overlay'

const stats = { replays: 2, fromHistory: 5, executed: 9, incidents: 1 }

describe('Overlay', () => {
  it('shows the level reached on the end-of-run card', () => {
    render(<Overlay phase={{ kind: 'over', reason: 'hit an obstacle' }} stats={stats} best={40} score={12} level={3} />)
    const level = screen.getByText('Level')
    expect(level.previousElementSibling).toHaveTextContent('3')
  })
})
