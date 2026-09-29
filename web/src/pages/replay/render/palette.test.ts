import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOT_TOKENS, readPalette, watchTheme } from './palette'

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
})

describe('readPalette', () => {
  it('reads each slot from its theme token, trimmed', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--accent-bright' ? ' lime ' : name === '--surface' ? 'white' : ''),
    } as unknown as CSSStyleDeclaration)
    const pal = readPalette(document.createElement('canvas'))
    expect(pal.player).toBe('lime')
    expect(pal.bg).toBe('white')
  })

  it('falls back to a neutral colour when a token is missing', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration)
    expect(readPalette(document.createElement('canvas')).coin).toBe('gray')
  })

  it('maps the hat slots to the Dapr hat tokens', () => {
    expect(SLOT_TOKENS.hat).toBe('--dapr-hat')
    expect(SLOT_TOKENS.hatOutline).toBe('--dapr-hat-outline')
  })

  it('maps every slot to a CSS custom property', () => {
    for (const token of Object.values(SLOT_TOKENS)) expect(token).toMatch(/^--[a-z-]+$/)
  })
})

describe('watchTheme', () => {
  it('calls back when the root data-theme changes, until disposed', async () => {
    const onChange = vi.fn()
    const dispose = watchTheme(onChange)
    document.documentElement.setAttribute('data-theme', 'dark')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    dispose()
    document.documentElement.setAttribute('data-theme', 'light')
    await new Promise((r) => setTimeout(r, 0))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
