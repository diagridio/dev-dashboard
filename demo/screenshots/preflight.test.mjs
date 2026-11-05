import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkDemo, DEMO_APPS } from './preflight.mjs'
import { TARGETS } from './targets.mjs'

// fakeFetch answers each app's /demo/status from a port -> behaviour map.
function fakeFetch(byPort) {
  return async (url) => {
    const port = new URL(url).port
    const b = byPort[port] ?? { seeded: true }
    if (b === 'reject') throw new Error('ECONNREFUSED')
    return { ok: true, status: 200, json: async () => b }
  }
}

test('reports unreachable app by name', async () => {
  const res = await checkDemo(fakeFetch({ 6002: 'reject' }), DEMO_APPS)
  assert.equal(res.ok, false)
  assert.ok(res.problems.includes('bridge (http://localhost:6002) unreachable'), res.problems.join('; '))
})

test('reports unseeded app', async () => {
  const res = await checkDemo(fakeFetch({ 6003: { seeded: false } }), DEMO_APPS)
  assert.equal(res.ok, false)
  assert.ok(res.problems.includes('sickbay not seeded'), res.problems.join('; '))
})

test('ok when all seeded', async () => {
  const res = await checkDemo(fakeFetch({}), DEMO_APPS)
  assert.deepEqual(res, { ok: true, problems: [] })
})

test('target names are unique and every README image ref has a target', () => {
  const names = TARGETS.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, 'duplicate target names')
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
  const refs = [...readme.matchAll(/docs\/images\/(.+?)-(light|dark)\.png/g)].map((m) => m[1])
  assert.ok(refs.length > 0, 'no themed image refs found in README')
  for (const base of refs) {
    assert.ok(names.includes(base), `README image ref "${base}" has no target`)
  }
})
