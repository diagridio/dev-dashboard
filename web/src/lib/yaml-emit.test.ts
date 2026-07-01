import { describe, it, expect } from 'vitest'
import { dumpYaml, recursivelyRemoveEmptyValues } from './yaml-emit'

describe('dumpYaml', () => {
  it('serializes a plain object to YAML', () => {
    expect(dumpYaml({ a: 1, b: 'x' })).toBe('a: 1\nb: x\n')
  })
})

describe('recursivelyRemoveEmptyValues', () => {
  it('removes null, undefined, empty string, whitespace string', () => {
    expect(recursivelyRemoveEmptyValues({ a: null, b: undefined, c: '', d: '  ', e: 'keep' })).toEqual({ e: 'keep' })
  })
  it('preserves 0 and false', () => {
    expect(recursivelyRemoveEmptyValues({ n: 0, b: false })).toEqual({ n: 0, b: false })
  })
  it('removes empty objects and empty arrays', () => {
    expect(recursivelyRemoveEmptyValues({ o: {}, a: [], keep: { x: 1 } })).toEqual({ keep: { x: 1 } })
  })
  it('prunes branches that become empty after recursion', () => {
    expect(recursivelyRemoveEmptyValues({ policies: { retries: { r1: { duration: '' } } } })).toEqual({})
  })
  it('keeps non-empty nested values and does not mutate the input', () => {
    const input = { spec: { timeout: '30s', extra: '' } }
    const out = recursivelyRemoveEmptyValues(input)
    expect(out).toEqual({ spec: { timeout: '30s' } })
    expect(input.spec.extra).toBe('') // original untouched
  })
})
