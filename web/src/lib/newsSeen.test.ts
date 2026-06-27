import { describe, it, expect, beforeEach } from 'vitest'
import { newsUrls, getSeen, markSeen, hasUnseen } from './newsSeen'
import type { NewsResponse } from '../types/logs'

const resp: NewsResponse = { blog: { title: 'B', url: 'u1' }, report: null, webinar: { title: 'W', url: 'u2' }, event: null }

beforeEach(() => localStorage.clear())

describe('newsSeen', () => {
  it('tracks unseen vs seen URLs', () => {
    expect(newsUrls(resp)).toEqual(['u1', 'u2'])
    expect(hasUnseen(resp)).toBe(true)
    markSeen(['u1', 'u2'])
    expect(getSeen().has('u1')).toBe(true)
    expect(hasUnseen(resp)).toBe(false)
  })
})
