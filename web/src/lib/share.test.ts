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
    for (const key of ['emailSubject', 'fullMessage', 'shortSocial'] as const) {
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
    expect(url).toContain(`text=${encodeURIComponent(shareContent.shortSocial)}`)
    expect(url).toContain(`url=${encodeURIComponent(REPO_URL)}`)
  })

  it('blueskyUrl includes short text and the repo url in the text', () => {
    const url = blueskyUrl()
    expect(url.startsWith('https://bsky.app/intent/compose?')).toBe(true)
    expect(url).toContain(encodeURIComponent(shareContent.shortSocial))
    expect(url).toContain(encodeURIComponent(REPO_URL))
  })

  it('linkedinUrl opens the feed composer with prefilled text and the repo url', () => {
    const url = linkedinUrl()
    expect(url.startsWith('https://www.linkedin.com/feed/?shareActive=true&text=')).toBe(true)
    expect(url).toContain(encodeURIComponent(shareContent.shortSocial))
    expect(url).toContain(encodeURIComponent(REPO_URL))
  })

  it('composed social messages fit their platform character limits', () => {
    const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length
    const bluesky = `${shareContent.shortSocial}\n${REPO_URL}`
    expect(graphemes(bluesky)).toBeLessThanOrEqual(300)
    const x = `${shareContent.shortSocial} ${REPO_URL}`
    expect(graphemes(x)).toBeLessThanOrEqual(280)
  })
})
