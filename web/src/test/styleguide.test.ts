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
      if (allow.has(rel.split(path.sep).join('/'))) continue
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

/**
 * Native form-control chrome — the popup a <select> or a datalist opens, plus
 * checkbox glyphs and scrollbars — is drawn by the browser and cannot be
 * reached by our CSS. `color-scheme` is the only switch, so each theme block
 * has to declare its own; without it every popup renders light, whatever the
 * tokens say.
 */
describe('theme.css native control chrome', () => {
  const css = readFileSync(path.join(srcDir, 'styles/theme.css'), 'utf8')

  /** The declarations inside `selector { … }`. */
  function block(selector: string): string {
    const start = css.indexOf(`${selector} {`)
    expect(start, `theme.css has no ${selector} block`).toBeGreaterThanOrEqual(0)
    const end = css.indexOf('}', start)
    return css.slice(start, end)
  }

  // The OS draws select/datalist popups outside the page and takes their
  // appearance from the DOCUMENT ROOT's color-scheme, so the root declaration
  // is the one that actually fixes a light dropdown in the dark theme; the
  // .app one covers in-page control internals.
  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
  ])('declares color-scheme: %s on the root and on .app for the %s theme', (theme, scheme) => {
    for (const selector of [`:root[data-theme="${theme}"]`, `.app[data-theme="${theme}"]`]) {
      expect(
        block(selector),
        `${selector} must declare color-scheme: ${scheme} so browser-drawn control popups ` +
          `(select, datalist) match the theme`,
      ).toMatch(new RegExp(`color-scheme:\\s*${scheme}\\b`))
    }
  })

  // Codifies the dropdown audit: both variants must keep sharing one chevron
  // rule, so a new one cannot quietly fall back to the OS arrow.
  it('styles both select variants from a single chevron rule', () => {
    expect(css).toMatch(/\.select,\s*select\.inp\s*\{[^}]*background-image:\s*var\(--chevron\)/)
  })

  // html/body sit behind the .app div and show through the macOS rubber-band
  // overscroll and the scrollbar gutter, so they must follow the theme too.
  it('paints body from the per-theme canvas token', () => {
    expect(block('body')).toMatch(/background:\s*var\(--canvas/)
  })

  /**
   * A disabled .btn.primary must not keep the accent fill: the green is the
   * signal that the action is available, so a gated Save (every dialog and
   * wizard uses one) has to read as unavailable until it is valid.
   */
  it('gives every button variant a disabled style', () => {
    for (const variant of ['primary', 'ghost', 'danger']) {
      expect(
        css,
        `theme.css has no .btn.${variant}:disabled rule — a disabled ${variant} button ` +
          `would look identical to an enabled one`,
      ).toMatch(new RegExp(`\\.btn\\.${variant}:disabled\\s*\\{`))
    }
    // The accent fill is what must go; assert it is actually replaced.
    const rule = /\.btn\.primary:disabled\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule, '.btn.primary:disabled must override the accent background').toMatch(
      /background:/,
    )
    expect(rule).not.toMatch(/var\(--accent-bright\)/)
  })

  /**
   * A disabled input or dropdown has to look unavailable too — otherwise the
   * only cue is a click that does nothing.
   */
  it('gives disabled form controls a distinct style', () => {
    for (const sel of ['.inp', '.select']) {
      const escaped = sel.replace('.', '\\.')
      expect(
        css,
        `theme.css has no ${sel}:disabled rule — a disabled control would look editable`,
      ).toMatch(new RegExp(`${escaped}:disabled`))
    }
    // The shared rule must actually change the fill and the text, not just the cursor.
    const rule = /[^{}]*\.inp:disabled[^{}]*\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/color:/)
    expect(rule).toMatch(/background(-color)?:/)
  })

  it('keeps the dark canvas identical to the dark app background', () => {
    const canvas = /--canvas:\s*([^;]+);/.exec(block(':root[data-theme="dark"]'))?.[1]?.trim()
    const appBg = /--bg:\s*([^;]+);/.exec(block('.app[data-theme="dark"]'))?.[1]?.trim()
    expect(canvas, ':root[data-theme="dark"] must define --canvas').toBeTruthy()
    expect(
      canvas,
      'the body canvas and the app background must be the same color, or the ' +
        'overscroll area shows a seam against the page',
    ).toBe(appBg)
  })
})

/**
 * Every <select> in the app takes one of the two sanctioned variants —
 * `.select` (filter bars) or `.inp` (form fields) — so dropdowns cannot drift
 * apart visually. See STYLEGUIDE.md §"Dropdowns".
 */
describe('dropdown variants', () => {
  /**
   * Comments discuss `<select>` in prose, so they are stripped before the scan:
   * block comments entirely, and any line whose first non-space is `//` (left
   * alone mid-line, so a `https://…` inside a string survives).
   */
  function code(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n')
  }

  it('gives every select the .select or .inp class', () => {
    const offenders: string[] = []
    for (const rel of sourceFiles()) {
      const src = code(readFileSync(path.join(srcDir, rel), 'utf8'))
      // Each <select …> opening tag, up to the closing angle bracket.
      for (const m of src.matchAll(/<select\b[^>]*>/g)) {
        const tag = m[0]
        if (!/className="(?:[^"]*\b)?(?:select|inp)\b[^"]*"/.test(tag)) {
          offenders.push(`${rel}: ${tag.replace(/\s+/g, ' ').slice(0, 90)}`)
        }
      }
    }
    expect(
      offenders,
      `<select> without the .select (filter) or .inp (form) variant — dropdowns must not ` +
        `drift apart, see STYLEGUIDE.md §Dropdowns:\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
