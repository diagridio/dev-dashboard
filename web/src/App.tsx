import { useEffect, useState } from 'react'
import { Outlet, useMatches } from 'react-router-dom'
import { SmallScreenGuard } from './components/SmallScreenGuard'
import { TopNav } from './components/TopNav'
import { ResourcesSidebar } from './components/ResourcesSidebar'
import { getTheme, type Theme } from './lib/prefs'
import { safeGet } from './lib/safeStorage'
import { trackAction, trackView } from './lib/telemetry'

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
  const matches = useMatches()

  const rumView = [...matches]
    .reverse()
    .map((m) => (m.handle as RouteHandle | undefined)?.rumView)
    .find(Boolean)

  useEffect(() => {
    trackAction('app_startup')
  }, [])

  useEffect(() => {
    if (rumView) trackView(rumView)
  }, [rumView])

  const appClass = ['app', collapsed ? 'collapsed' : '', hasNew ? 'has-new' : ''].filter(Boolean).join(' ')

  return (
    <SmallScreenGuard>
      <div className={appClass} data-theme={theme}>
        <TopNav theme={theme} onThemeChange={setTheme} />
        <ResourcesSidebar
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onHasNewChange={setHasNew}
        />
        <main className="body">
          <Outlet />
        </main>
      </div>
    </SmallScreenGuard>
  )
}
