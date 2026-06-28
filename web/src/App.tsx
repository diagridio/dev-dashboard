import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { SmallScreenGuard } from './components/SmallScreenGuard'
import { TopNav } from './components/TopNav'
import { ResourcesSidebar } from './components/ResourcesSidebar'
import { getTheme, type Theme } from './lib/prefs'

export function App() {
  const [theme, setTheme] = useState<Theme>(getTheme)
  const [collapsed, setCollapsed] = useState(false)
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
        <div className="body">
          <Outlet />
        </div>
      </div>
    </SmallScreenGuard>
  )
}
