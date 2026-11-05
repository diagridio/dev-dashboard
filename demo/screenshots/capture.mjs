// Capture every dashboard page from the running Enterprise diagnostics demo,
// in light and dark mode, into docs/images/<name>-<theme>.png.
//
// Usage: node capture.mjs            (DASH_URL defaults to http://localhost:9090)
//        ONLY=workflow-detail,logs node capture.mjs   (capture a subset)
//
// Expects the demo (make demo) and the dashboard to be running already.

import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { checkDemo, DEMO_APPS } from './preflight.mjs'
import { TARGETS } from './targets.mjs'

const BASE = (process.env.DASH_URL ?? 'http://localhost:9090').replace(/\/+$/, '')
const OUT_DIR = fileURLToPath(new URL('../../docs/images/', import.meta.url))
const THEMES = ['light', 'dark']
const TIMEOUT_MS = 30_000
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null

// Existing localStorage switches: theme, paused polling (frozen data while we
// capture), CLI drawer closed (the cli-drawer target opens it itself) and the
// resources sidebar collapsed (hides the News panel, whose content changes).
function initStorage(theme) {
  localStorage.setItem('devdash.theme', theme)
  localStorage.setItem('devdash.refreshPaused', 'true')
  localStorage.setItem('devdash.cliDrawerOpen', 'false')
  localStorage.setItem('devdash.sidebarCollapsed', 'true')
}

async function preflight() {
  const res = await checkDemo(fetch, DEMO_APPS)
  if (!res.ok) {
    console.error('Demo is not ready, no screenshots written:')
    for (const p of res.problems) console.error(`  - ${p}`)
    console.error('Start it with `make demo` (and `make demo-reset` if it is running but unseeded).')
    process.exit(1)
  }
  try {
    const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (err) {
    console.error(`Dashboard at ${BASE} is not reachable (${err.message}), no screenshots written.`)
    process.exit(1)
  }
}

async function settle(page, target) {
  await page.getByText(target.waitFor).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: TIMEOUT_MS })
  // Loading placeholders ("Loading…") and spinners must be gone.
  await page.waitForFunction(
    () =>
      !document.querySelector('[data-cy="spinner"]') &&
      ![...document.querySelectorAll('main *, .app *')].some(
        (el) => el.childElementCount === 0 && /^Loading\b/.test(el.textContent?.trim() ?? '') && el.checkVisibility(),
      ),
    null,
    { timeout: TIMEOUT_MS },
  )
  // Resource detail panels load their YAML in a separate request with no
  // loading text; wait for the YAML body when the panel is on the page.
  if (await page.getByText('Copy YAML').filter({ visible: true }).count()) {
    await page.getByText('apiVersion').filter({ visible: true }).first().waitFor({ timeout: TIMEOUT_MS })
  }
  await page.evaluate(() => document.fonts.ready)
}

async function main() {
  await preflight()
  const targets = only ? TARGETS.filter((t) => only.has(t.name)) : TARGETS
  if (targets.length === 0) {
    console.error(`No targets match ONLY=${process.env.ONLY}`)
    process.exit(1)
  }
  mkdirSync(OUT_DIR, { recursive: true })

  const browser = await chromium.launch()
  const failed = []
  try {
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: 'reduce',
      })
      await context.addInitScript(initStorage, theme)
      const page = await context.newPage()
      page.setDefaultTimeout(TIMEOUT_MS)
      for (const target of targets) {
        const file = `${OUT_DIR}${target.name}-${theme}.png`
        try {
          await page.goto(BASE + target.path, { waitUntil: 'domcontentloaded' })
          await settle(page, target)
          if (target.prepare) await target.prepare(page)
          await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' })
          console.log(`ok    ${target.name}-${theme}.png`)
        } catch (err) {
          failed.push(`${target.name}-${theme}`)
          console.error(`FAIL  ${target.name}-${theme}: ${err.message.split('\n')[0]}`)
        }
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} target(s) failed: ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log(`\nWrote ${targets.length * THEMES.length} screenshots to docs/images/`)
}

await main()
