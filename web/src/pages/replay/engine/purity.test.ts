/**
 * The engine must be a pure function of (state, inputs, ports). This guard
 * fails if an engine source file reaches for an impure global directly.
 * Comments and string literals are ignored: docs and tip copy may name them.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const banned = /\b(Math\.random|Date|performance|window|document|localStorage)\b/

/** A source line with its string literals and comments removed. */
function code(line: string): string {
  if (/^\s*(\/\*|\*)/.test(line)) return ''
  return line
    .replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''")
    .replace(/\/\/.*$/, '')
}

describe('engine purity', () => {
  it('engine sources reference no impure globals', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const f of files) {
      readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (banned.test(code(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, `impure globals in engine/:\n${offenders.join('\n')}`).toEqual([])
  })
})
