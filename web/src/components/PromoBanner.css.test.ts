import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

// jsdom doesn't load theme.css, so the banner's layout guarantees are pinned here.
const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../styles')
const css = readFileSync(path.join(stylesDir, 'theme.css'), 'utf8')

/** The declarations inside `selector { … }`. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `theme.css has no ${selector} block`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('promotion banner CSS', () => {
  it('moves left of the open CLI drawer instead of covering it', () => {
    expect(block('.cli-drawer.open ~ .promo')).toMatch(/right:\s*calc\(min\(33vw, 33%\) \+ 20px\)/)
  })

  it('is hidden from focus and assistive tech until it slides in', () => {
    expect(block('.promo')).toMatch(/visibility:\s*hidden/)
    expect(block('.promo.show')).toMatch(/visibility:\s*visible/)
  })

  it('gives the call-to-action link the standard focus ring', () => {
    expect(block('.promo-link:focus-visible')).toMatch(/outline:\s*2px solid var\(--accent-bright\)/)
  })

  it('wraps long unbroken words instead of overflowing the card', () => {
    expect(block('.promo-body')).toMatch(/overflow-wrap:\s*anywhere/)
  })
})
