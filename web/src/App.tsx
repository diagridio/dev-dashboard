import { useEffect, useState } from 'react'
import { Outlet, useMatches, useSearchParams } from 'react-router-dom'
import { SmallScreenGuard } from './components/SmallScreenGuard'
import { TopNav } from './components/TopNav'
import { ResourcesSidebar } from './components/ResourcesSidebar'
import { CliDrawer } from './components/CliDrawer'
import { getTheme, type Theme } from './lib/prefs'
import { safeGet } from './lib/safeStorage'
import { trackAction, trackView } from './lib/telemetry'
import { useDiscoveryTelemetry } from './hooks/useDiscoveryTelemetry'

const SIDEBAR_COLLAPSED_KEY = 'devdash.sidebarCollapsed'

function getInitialCollapsed(): boolean {
  return safeGet(SIDEBAR_COLLAPSED_KEY) === 'true'
}

interface RouteHandle {
  rumView?: string
}

export function App() {
  const [theme, setTheme] = useState<Theme>(getTheme)
  const [collapsed, setCollapsed] = useState(getInitialCollapsed)
  const [hasNew, setHasNew] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const matches = useMatches()

  const rumView = [...matches]
    .reverse()
    .map((m) => (m.handle as RouteHandle | undefined)?.rumView)
    .find(Boolean)

  const [searchParams] = useSearchParams()
  const leafParams = (matches[matches.length - 1]?.params ?? {}) as Record<string, string | undefined>
  const cliValues = {
    appId: leafParams.appId ?? searchParams.get('app') ?? undefined,
    instanceId: leafParams.instanceId ?? undefined,
  }

  // Mounted here (not per-route) so the ['apps'] react-query stays active on
  // every route, keeping the `modes` telemetry context live app-wide — do
  // not "optimize" this by moving it closer to where apps are displayed.
  useDiscoveryTelemetry()

  useEffect(() => {
    trackAction('app_startup')
  }, [])

  useEffect(() => {
    if (rumView) trackView(rumView)
  }, [rumView])

  // The theme has to reach <html>, not just the .app div: a <select> or
  // <datalist> popup is drawn by the OS outside the page, and the browser takes
  // its light/dark appearance from the document root's color-scheme (see the
  // :root[data-theme] rules in theme.css). An ancestor div cannot reach it.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const appClass = ['app', collapsed ? 'collapsed' : '', hasNew ? 'has-new' : '', updateAvailable ? 'update-available' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <SmallScreenGuard>
      <div className={appClass} data-theme={theme}>
        <TopNav theme={theme} onThemeChange={setTheme} />
        <ResourcesSidebar
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onHasNewChange={setHasNew}
          onUpdateAvailableChange={setUpdateAvailable}
        />
        <main className="body">
          <Outlet />
        </main>
        <CliDrawer context={rumView} values={cliValues} />
      </div>
    </SmallScreenGuard>
  )
}
