/**
 * Styleguide enforcement.
 *
 * The project deliberately has no ESLint setup, so the cheap style rules that
 * would otherwise be lint rules live here as tests:
 *
 * 1. Freshness — every backtick-quoted `components/….tsx` path referenced in
 *    STYLEGUIDE.md must exist, so deleting/renaming a component fails loudly
 *    until the doc is updated (this is how stale entries like the removed
 *    LiveIndicator get caught).
 * 2. No hex color literals in TS/TSX — colors come from theme tokens
 *    (`var(--…)`). Allowlisted: the Logo's fixed brand fills and the
 *    runtime-language swatch map (external brand colors with no theme token).
 * 3. No template-literal className without a static prefix — a class token
 *    interpolated from raw data can collide with an unrelated global class
 *    (see the STYLEGUIDE §1 antipattern: `class="lsrc app"` matching `.app`).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webDir = path.resolve(srcDir, '..')
const styleguidePath = path.join(webDir, 'STYLEGUIDE.md')

/** All non-test .ts/.tsx source files under src/, as src-relative paths. */
function sourceFiles(dir = srcDir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Skip the test harness dir (this file's own regexes would trip the scan).
      if (full === path.join(srcDir, 'test')) continue
      sourceFiles(full, out)
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name)
    ) {
      out.push(path.relative(srcDir, full))
    }
  }
  return out
}

describe('STYLEGUIDE.md freshness', () => {
  it('every backtick-quoted components/*.tsx path in the styleguide exists', () => {
    const doc = readFileSync(styleguidePath, 'utf8')
    const refs = [...doc.matchAll(/`((?:src\/)?components\/[\w./-]+\.tsx)`/g)]
      .map((m) => m[1].replace(/^src\//, ''))
    // Sanity: if the regex ever stops matching anything, the guard is dead.
    expect(refs.length).toBeGreaterThanOrEqual(5)
    const missing = [...new Set(refs)].filter(
      (rel) => !existsSync(path.join(srcDir, rel)),
    )
    expect(
      missing,
      `STYLEGUIDE.md references components that no longer exist: ${missing.join(', ')}. ` +
        'Update the styleguide (component catalog / examples) to match the code.',
    ).toEqual([])
  })
})

describe('styleguide lint guards', () => {
  const files = sourceFiles()

  it('finds a plausible number of source files', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('no hex color literals outside the allowlist (use var(--…) tokens)', () => {
    // Fixed brand colors that have no theme token. runtimeSwatch is listed both
    // as the shared lib helper and at its current in-page locations so the
    // guard holds before and after that extraction lands.
    const allow = new Set([
      'lib/runtimeSwatch.ts',
      'pages/Applications.tsx',
      'pages/AppDetail.tsx',
      'components/Logo.tsx',
    ])
    // 3/4/6/8-digit CSS hex. (?<!&) skips HTML entities like &#9888;.
    const hex = /(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/
    const offenders: string[] = []
    for (const rel of files) {
      if (allow.has(rel)) continue
      const lines = readFileSync(path.join(srcDir, rel), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (hex.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(
      offenders,
      `Hex color literal(s) found — use a var(--…) theme token instead ` +
        `(see STYLEGUIDE.md "golden rule"; genuine brand-color one-offs go in the allowlist):\n` +
        offenders.join('\n'),
    ).toEqual([])
  })

  it('no template-literal className starting with an interpolation (needs a static prefix)', () => {
    // className={`${x} …`} — the first class token comes from data, so it can
    // collide with any global class (STYLEGUIDE.md §1 antipattern). A static
    // prefix (className={`lsrc lsrc-${x}`}) namespaces it.
    const bad = /className=\{`\s*\$\{/
    const offenders: string[] = []
    for (const rel of files) {
      const lines = readFileSync(path.join(srcDir, rel), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (bad.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(
      offenders,
      `className template literal(s) start with interpolated data — prefix with a ` +
        `static, component-namespaced token (see STYLEGUIDE.md §1 antipattern):\n` +
        offenders.join('\n'),
    ).toEqual([])
  })
})
