import { describe, it, expect, vi, beforeEach } from 'vitest'
import { copyText } from './clipboard'

describe('copyText', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('calls navigator.clipboard.writeText in a secure context', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      configurable: true,
    })
    copyText('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('falls back to legacyCopy when clipboard API is unavailable', () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(window, 'isSecureContext', {
      value: false,
      configurable: true,
    })
    // jsdom does not implement execCommand; stub it so legacyCopy doesn't throw
    document.execCommand = vi.fn()
    // Should not throw
    expect(() => copyText('fallback')).not.toThrow()
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })
})
