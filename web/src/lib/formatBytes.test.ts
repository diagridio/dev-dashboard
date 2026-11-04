import { describe, it, expect } from 'vitest'
import { formatBytes } from './formatBytes'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [131102, '128.0 KiB'],
    [1048576, '1.0 MiB'],
    [1572864, '1.5 MiB'],
    [1073741824, '1.0 GiB'],
  ])('%d -> %s', (n, s) => {
    expect(formatBytes(n)).toBe(s)
  })
})
