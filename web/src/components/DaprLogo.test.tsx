import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DaprLogo } from './DaprLogo'

const themeCss = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../styles/theme.css')

describe('DaprLogo', () => {
  it('renders an accessible svg labelled Dapr', () => {
    const svg = render(<DaprLogo />).container.querySelector('svg')!
    expect(svg.getAttribute('aria-label')).toBe('Dapr')
    expect(svg.getAttribute('viewBox')).toBe('0 0 480 359.12279')
  })

  // Same pattern as Logo.tsx: shapes fill with currentColor and CSS sets the
  // colour, so no var() lives in an SVG presentation attribute.
  it('fills its shapes with currentColor', () => {
    const { container } = render(<DaprLogo />)
    const shapes = container.querySelectorAll('path, polygon, rect')
    expect(shapes.length).toBeGreaterThan(0)
    for (const s of shapes) expect(s.getAttribute('fill')).toBe('currentColor')
  })

  it('takes its colour from the --dapr-logo token in CSS', () => {
    const css = readFileSync(themeCss, 'utf8')
    expect(css).toMatch(/\.daprlogo\s*\{[^}]*color:\s*var\(--dapr-logo\)/)
  })

  it('defines --dapr-logo for both themes', () => {
    const css = readFileSync(themeCss, 'utf8')
    expect(css.match(/--dapr-logo:/g)?.length).toBe(2)
  })
})
