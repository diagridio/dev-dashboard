import { describe, expect, it, vi } from 'vitest'
import { MAX_RUN_CODE, MAX_TAPE_JSON, RUN_CODE_PREFIX, copyRunCode, decodeRun, encodeRun, shareableRunCode } from './share'
import { emptyTape, type Tape } from './tape'
import type { SaveBody } from './types'

const save: SaveBody = {
  version: 2,
  date: '2026-09-30',
  start: { level: 2, seed: 99, score: 5, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 },
  history: [
    { type: 'Input', tick: 3, kind: 'jump' },
    { type: 'ActivityCoinCollected', tick: 10, id: 4, hash: 123 },
  ],
  tick: 31,
  stats: { replays: 1, fromHistory: 2, executed: 3, incidents: 0, retriesUsed: 0, circuitTrips: 1, boostsLost: 2 },
  divergedAt: null,
  segments: [],
  orbValues: [],
}

const tape: Tape = {
  ...emptyTape('2026-09-30'),
  inputs: Array.from({ length: 400 }, (_, i) => [i * 7, i % 2 ? 'jump' : 'jumpEnd'] as [number, 'jump' | 'jumpEnd']),
  impure: [1, 2, 3, 4294967295],
  chaos: [9, 8, 7],
  restarts: [{ liveTick: 100, impureAt: 1, chaosAt: 2, save }],
  liveTick: 2900,
}

describe('run codes', () => {
  it('round-trips a tape through a compact, prefixed, URL-safe code', async () => {
    const code = await encodeRun(tape)
    expect(code.startsWith(RUN_CODE_PREFIX)).toBe(true)
    expect(code).toMatch(/^RPL1\.[A-Za-z0-9_-]+$/)
    expect(code.length).toBeLessThan(JSON.stringify(tape).length)
    expect(await decodeRun(code)).toEqual(tape)
  })

  it('ignores whitespace and line breaks added when the code was pasted', async () => {
    const code = await encodeRun(tape)
    const wrapped = `  ${code.slice(0, 20)}\n${code.slice(20, 50)} \r\n${code.slice(50)}\n`
    expect(await decodeRun(wrapped)).toEqual(tape)
  })

  it.each([
    ['empty', ''],
    ['wrong prefix', 'RPL2.abc'],
    ['not base64', 'RPL1.***'],
    ['not deflate', `RPL1.${btoa('hello world')}`],
  ])('rejects a %s code', async (_name, code) => {
    expect(await decodeRun(code)).toBeNull()
  })

  it('rejects a well-formed code whose content is not a tape', async () => {
    const code = await encodeRun({ nope: true } as unknown as Tape)
    expect(await decodeRun(code)).toBeNull()
  })

  it('rejects codes over MAX_RUN_CODE without decoding them', async () => {
    const ctor = vi.fn()
    vi.stubGlobal('DecompressionStream', ctor)
    try {
      expect(await decodeRun(RUN_CODE_PREFIX + 'A'.repeat(MAX_RUN_CODE))).toBeNull()
      expect(ctor).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects a small code that inflates past MAX_TAPE_JSON (deflate bomb)', async () => {
    // A valid-shaped tape padded with highly compressible values: tiny code, huge JSON.
    const bomb: Tape = { ...tape, impure: new Array<number>(Math.ceil(MAX_TAPE_JSON / 2) + 1000).fill(0) }
    expect(JSON.stringify(bomb).length).toBeGreaterThan(MAX_TAPE_JSON)
    const code = await encodeRun(bomb)
    expect(code.length).toBeLessThan(MAX_RUN_CODE)
    expect(await decodeRun(code)).toBeNull()
  })
})

describe('copyRunCode', () => {
  it('copies to the clipboard when it can', async () => {
    const writeText = vi.fn(async () => {})
    expect(await copyRunCode('RPL1.x', { writeText })).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('RPL1.x')
  })

  it('falls back to manual copy when the clipboard is missing or refuses', async () => {
    expect(await copyRunCode('RPL1.x', undefined)).toBe('manual')
    expect(await copyRunCode('RPL1.x', { writeText: async () => { throw new Error('denied') } })).toBe('manual')
  })
})

describe('shareableRunCode', () => {
  it('gives the code for a normal tape', async () => {
    expect(await shareableRunCode(tape)).toBe(await encodeRun(tape))
  })

  it('gives null when the code would exceed what decodeRun accepts', async () => {
    let x = 12345
    const noise = Array.from({ length: 200_000 }, () => (x = (Math.imul(x, 1103515245) + 12345) >>> 0))
    expect(await shareableRunCode({ ...tape, impure: noise })).toBeNull()
  })
})
