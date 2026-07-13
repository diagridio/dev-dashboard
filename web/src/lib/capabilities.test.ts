import { describe, it, expect, afterEach } from 'vitest'
import { getCapabilities } from './capabilities'

declare global {
  interface Window {
    __DASH_CAPABILITIES__?: import('./capabilities').Capabilities
  }
}

describe('getCapabilities', () => {
  afterEach(() => {
    delete window.__DASH_CAPABILITIES__
  })

  it('defaults to everything enabled when the flag is absent (dev server)', () => {
    expect(getCapabilities()).toEqual({
      lifecycle: true,
      controlPlane: true,
      logs: true,
      workflows: true,
      mode: '',
    })
  })

  it('returns the injected flags verbatim', () => {
    window.__DASH_CAPABILITIES__ = {
      lifecycle: false,
      controlPlane: false,
      logs: false,
      workflows: true,
    }
    expect(getCapabilities().lifecycle).toBe(false)
    expect(getCapabilities().workflows).toBe(true)
  })
})
