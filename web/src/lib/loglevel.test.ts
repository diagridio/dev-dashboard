import { describe, it, expect } from 'vitest'
import { parseLogLevel } from './loglevel'

describe('parseLogLevel', () => {
  it('parses logfmt and bare tokens', () => {
    expect(parseLogLevel('time=2024 level=error msg=boom')).toBe('error')
    expect(parseLogLevel('level=warning something')).toBe('warn')
    expect(parseLogLevel('INFO starting up')).toBe('info')
    expect(parseLogLevel('2024 DEBU detail')).toBe('debug')
    expect(parseLogLevel('plain line')).toBeUndefined()
  })
})
