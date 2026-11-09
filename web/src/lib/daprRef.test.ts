import { describe, it, expect } from 'vitest'
import { parseDaprRef } from './daprRef'

const sha = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const inner = {
  v: 1,
  store: 'workflow-payloads',
  key: `workflow-payloads/order-42/${sha}`,
  size: 131102,
  sha256: sha,
}
const env = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ $daprRef: { ...inner, ...over } })
const drop = (k: string) => {
  const c: Record<string, unknown> = { ...inner }
  delete c[k]
  return JSON.stringify({ $daprRef: c })
}

describe('parseDaprRef', () => {
  it('parses a valid minimal envelope', () => {
    const r = parseDaprRef(env())
    expect(r).toEqual({ kind: 'ref', ref: inner })
  })

  it('tolerates leading whitespace', () => {
    expect(parseDaprRef('  \n' + env()).kind).toBe('ref')
  })

  it.each(['', '   ', '42', '"text"', '[1]'])('treats %j as data', (t) => {
    expect(parseDaprRef(t)).toEqual({ kind: 'data' })
  })

  it('treats unparseable non-envelope text as data', () => {
    expect(parseDaprRef('{not json')).toEqual({ kind: 'data' })
  })

  it('flags unparseable text mentioning $daprRef as invalid', () => {
    expect(parseDaprRef('{not json $daprRef')).toEqual({ kind: 'invalid', reason: 'not valid JSON' })
  })

  it('treats extra sibling properties as data', () => {
    expect(parseDaprRef(JSON.stringify({ $daprRef: inner, other: 1 }))).toEqual({ kind: 'data' })
  })

  it('treats a nested envelope as data', () => {
    expect(parseDaprRef(JSON.stringify({ order: { $daprRef: inner } }))).toEqual({ kind: 'data' })
  })

  it.each([
    ['v 2', env({ v: 2 })],
    ['missing store', drop('store')],
    ['blank store', env({ store: '  ' })],
    ['missing key', drop('key')],
    ['negative size', env({ size: -1 }) ],
    ['fractional size', env({ size: 1.5 })],
    ['unsafe size', '{"$daprRef":{"v":1,"store":"s","key":"k","size":9007199254740992,"sha256":"' + sha + '"}}'],
    ['uppercase sha', env({ sha256: sha.toUpperCase() })],
    ['short sha', env({ sha256: sha.slice(1) })],
    ['empty stage', env({ stages: [{}] })],
    ['stages not array', env({ stages: 'x' })],
    ['$daprRef not object', '{"$daprRef":5}'],
  ])('invalid: %s', (_n, text) => {
    const r = parseDaprRef(text)
    expect(r.kind).toBe('invalid')
  })

  it('names the failing member', () => {
    expect(parseDaprRef(env({ v: 2 }))).toEqual({ kind: 'invalid', reason: 'v must be 1' })
    expect(parseDaprRef(env({ sha256: 'abc' }))).toEqual({
      kind: 'invalid',
      reason: 'sha256 must be 64 lowercase hex characters',
    })
  })

  it('preserves stages', () => {
    const r = parseDaprRef(env({ stages: [{ n: 'gzip' }, { n: 'enc', m: { k: 'v' } }] }))
    expect(r).toEqual({ kind: 'ref', ref: { ...inner, stages: [{ n: 'gzip' }, { n: 'enc', m: { k: 'v' } }] } })
  })
})
