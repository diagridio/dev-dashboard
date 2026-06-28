import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { SmallScreenGuard } from './components/SmallScreenGuard'
import { TopNav } from './components/TopNav'
import { ResourcesSidebar } from './components/ResourcesSidebar'
import { getTheme, type Theme } from './lib/prefs'

const SIDEBAR_COLLAPSED_KEY = 'devdash.sidebarCollapsed'

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function App() {
  const [theme, setTheme] = useState<Theme>(getTheme)
  const [collapsed, setCollapsed] = useState(getInitialCollapsed)
  const [hasNew, setHasNew] = useState(false)

  const appClass = ['app', collapsed ? 'collapsed' : '', hasNew ? 'has-new' : ''].filter(Boolean).join(' ')

  return (
    <SmallScreenGuard>
      <div className={appClass} data-theme={theme}>
        <TopNav theme={theme} onThemeChange={setTheme} />
        <ResourcesSidebar
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          hasNew={hasNew}
          onHasNewChange={setHasNew}
        />
        <main className="body">
          <Outlet />
        </main>
      </div>
    </SmallScreenGuard>
  )
}
