import { useEffect, useState } from 'react'
import { Outlet, useLocation, useMatches, useNavigate, useSearchParams } from 'react-router-dom'
import { SmallScreenGuard } from './components/SmallScreenGuard'
import { TopNav } from './components/TopNav'
import { ResourcesSidebar } from './components/ResourcesSidebar'
import { CliDrawer } from './components/CliDrawer'
import { getCapabilities } from './lib/capabilities'
import { PromoBanner } from './components/PromoBanner'
import { getTheme, type Theme } from './lib/prefs'
import { trackAction, trackView } from './lib/telemetry'
import { useDiscoveryTelemetry } from './hooks/useDiscoveryTelemetry'
import { useKonami } from './hooks/useKonami'
import { useCtrlKeyToggle } from './hooks/useCtrlKeyToggle'

interface RouteHandle {
  rumView?: string
}

export function App() {
  const [theme, setTheme] = useState<Theme>(getTheme)
  // Not persisted on purpose: the start state comes from the server config
  // (open by default, collapsed with --resources-collapsed) on every dashboard start.
  const [collapsed, setCollapsed] = useState(() => getCapabilities().resourcesCollapsed === true)
  const [hasNew, setHasNew] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  // Easter egg: Ctrl+B swaps the Diagrid logo for the Dapr logo and hides the
  // Resources sidebar; Ctrl+B again restores both. Ctrl keeps the Konami
  // code's plain B from triggering it.
  const daprMode = useCtrlKeyToggle('b')
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
  // Easter egg: ↑↑↓↓←→←→BA opens the REPLAY game (pages/replay).
  // useLocation's pathname is router-relative (no basename), like the '/replay' route.
  const navigate = useNavigate()
  const { pathname } = useLocation()
  useKonami(() => {
    if (pathname !== '/replay') navigate('/replay')
  })

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

  const appClass = ['app', collapsed ? 'collapsed' : '', hasNew ? 'has-new' : '', updateAvailable ? 'update-available' : '', daprMode ? 'dapr-mode' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <SmallScreenGuard>
      <div className={appClass} data-theme={theme}>
        <TopNav theme={theme} onThemeChange={setTheme} daprLogo={daprMode} />
        {!daprMode && (
          <ResourcesSidebar
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
            onHasNewChange={setHasNew}
            onUpdateAvailableChange={setUpdateAvailable}
          />
        )}
        {/* tabIndex -1: programmatic focus target (e.g. after closing the promotion banner). */}
        <main className="body" tabIndex={-1}>
          <Outlet />
        </main>
        <CliDrawer context={rumView} values={cliValues} />
        {/* Not on REPLAY (and so not in its kiosk mode): the game owns the whole frame. */}
        {pathname !== '/replay' && getCapabilities().hidePromotion !== true && <PromoBanner />}
      </div>
    </SmallScreenGuard>
  )
}
