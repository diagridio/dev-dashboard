import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { KONAMI, konamiLabel } from '../hooks/useKonami'
import { KonamiHint } from './KonamiHint'

describe('KonamiHint', () => {
  it('spells out the exact sequence the Konami hook listens for', () => {
    expect(konamiLabel(KONAMI)).toBe('↑ ↑ ↓ ↓ ← → ← → B A')
  })

  it('renders it as a labelled mono hint', () => {
    render(<KonamiHint />)
    const hint = screen.getByLabelText('Konami code')
    expect(hint).toHaveTextContent('↑ ↑ ↓ ↓ ← → ← → B A')
    expect(hint).toHaveClass('konami-hint')
  })
})
