import { describe, it, expect } from 'vitest'
import {
  REPO_URL,
  shareContent,
  emailUrl,
  xUrl,
  linkedinUrl,
  blueskyUrl,
} from './share'

describe('shareContent', () => {
  it('has all required non-empty keys', () => {
    for (const key of ['emailSubject', 'fullMessage', 'shortX', 'shortBluesky'] as const) {
      expect(typeof shareContent[key]).toBe('string')
      expect(shareContent[key].trim().length).toBeGreaterThan(0)
    }
  })

  it('full message contains the repo URL and both install commands', () => {
    expect(shareContent.fullMessage).toContain(REPO_URL)
    expect(shareContent.fullMessage).toContain('scripts/install.sh | sh')
    expect(shareContent.fullMessage).toContain('scripts/install.ps1 | iex')
  })
})

describe('channel URL builders', () => {
  it('emailUrl encodes subject and full-message body', () => {
    const url = emailUrl()
    expect(url.startsWith('mailto:?')).toBe(true)
    expect(url).toContain(`subject=${encodeURIComponent(shareContent.emailSubject)}`)
    expect(url).toContain(`body=${encodeURIComponent(shareContent.fullMessage)}`)
  })

  it('xUrl points at the intent endpoint with short text and repo url', () => {
    const url = xUrl()
    expect(url.startsWith('https://x.com/intent/tweet?')).toBe(true)
    expect(url).toContain(`text=${encodeURIComponent(shareContent.shortX)}`)
    expect(url).toContain(`url=${encodeURIComponent(REPO_URL)}`)
  })

  it('blueskyUrl includes short text and the repo url in the text', () => {
    const url = blueskyUrl()
    expect(url.startsWith('https://bsky.app/intent/compose?')).toBe(true)
    expect(url).toContain(encodeURIComponent(shareContent.shortBluesky))
    expect(url).toContain(encodeURIComponent(REPO_URL))
  })

  it('linkedinUrl shares the repo url only', () => {
    const url = linkedinUrl()
    expect(url.startsWith('https://www.linkedin.com/sharing/share-offsite/?')).toBe(true)
    expect(url).toContain(`url=${encodeURIComponent(REPO_URL)}`)
  })
})
