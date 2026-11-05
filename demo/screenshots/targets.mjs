// Every dashboard screenshot target. Adding a page is one line here.
//
//   name     -> docs/images/<name>-<light|dark>.png
//   path     -> router path, appended to DASH_URL
//   waitFor  -> text (or list of texts, all required) that only shows once
//               the seeded data has loaded
//   prepare  -> optional async (page) => {} interaction before the screenshot
//
// State is filtered to sickbay: an unfiltered first page can be all internal
// workflow/actor keys, which the page hides.

export const TARGETS = [
  { name: 'applications', path: '/', waitFor: 'sickbay' },
  // 'App protocol' is a detail-only label; the app list also says 'engineering'.
  { name: 'application-detail', path: '/apps/engineering', waitFor: ['engineering', 'App protocol'] },
  { name: 'workflow-overview', path: '/workflows', waitFor: 'sweep-002' },
  { name: 'workflow-detail', path: '/workflows/engineering/sweep-002', waitFor: 'plasma conduit rupture' },
  {
    name: 'workflow-dataref',
    path: '/workflows/engineering/sweep-006',
    waitFor: 'sweep-006',
    prepare: async (page) => {
      // Open history events until one shows the $daprRef card, then bring it into view.
      const card = page.locator('.refcard').filter({ visible: true }).first()
      const summaries = page.locator('details.evd > summary')
      const n = await summaries.count()
      for (let i = 0; i < n && !(await card.count()); i++) {
        await summaries.nth(i).click()
      }
      await card.waitFor({ timeout: 5000 })
      await card.evaluate((el) => el.closest('.ev').scrollIntoView({ block: 'center' }))
    },
  },
  { name: 'actors', path: '/actors', waitFor: 'SubsystemActor' },
  // Bridge publishes the alerts/results after sickbay seeds the crew log.
  { name: 'state', path: '/state?app=sickbay', waitFor: ['crewlog-0001', 'alert-RA-0004', 'result-DR-0001'] },
  {
    name: 'state-records',
    path: '/state?app=sickbay',
    waitFor: 'crewlog-0001',
    prepare: async (page) => {
      await page.locator('tbody tr', { hasText: 'crewlog-0001' }).first().click()
      await page.locator('tbody tr.sel').waitFor()
    },
  },
  { name: 'subscriptions', path: '/subscriptions', waitFor: 'red-alert' },
  {
    name: 'publish-message',
    path: '/subscriptions',
    waitFor: 'red-alert',
    prepare: async (page) => {
      // red-alert-sub is the declarative subscription on topic "red-alert".
      const row = page.locator('tbody tr').filter({ has: page.locator('td', { hasText: /^red-alert$/ }) })
      await row.first().getByRole('button', { name: 'Publish' }).click()
      await page.getByRole('dialog').waitFor()
    },
  },
  { name: 'components', path: '/components', waitFor: 'command-codes' },
  { name: 'component-detail', path: '/components/statestore', waitFor: 'state.redis' },
  { name: 'component-builder', path: '/components/new', waitFor: 'New component' },
  { name: 'configurations', path: '/configurations', waitFor: 'diagnostics' },
  { name: 'resiliency', path: '/resiliency', waitFor: 'ship-systems' },
  { name: 'resiliency-builder', path: '/resiliency/new', waitFor: 'New resiliency policy' },
  { name: 'http-endpoints', path: '/http-endpoints', waitFor: 'starfleet-command' },
  { name: 'control-plane', path: '/control-plane', waitFor: 'dapr_placement' },
  { name: 'logs', path: '/logs?app=engineering', waitFor: 'demo seeded' },
  {
    name: 'cli-drawer',
    path: '/workflows',
    waitFor: 'sweep-002',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'CLI commands', exact: true }).click()
      await page.locator('.cli-drawer.open').waitFor()
    },
  },
]
