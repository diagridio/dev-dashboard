import { NavLink } from 'react-router-dom'
import { Logo } from './Logo'
import { ThemeToggle } from './ThemeToggle'
import { RefreshControl } from './RefreshControl'
import type { Theme } from '../lib/prefs'

export interface NavItem {
  label: string
  to: string
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Applications', to: '/' },
  { label: 'Workflows', to: '/workflows' },
  { label: 'Actors', to: '/actors' },
  { label: 'Subscriptions', to: '/subscriptions' },
  { label: 'Components', to: '/components' },
  { label: 'Configurations', to: '/configurations' },
  { label: 'Logs', to: '/logs' },
]

interface TopNavProps {
  theme: Theme
  onThemeChange: (t: Theme) => void
}

export function TopNav({ theme, onThemeChange }: TopNavProps) {
  return (
    <header className="topbar">
      <span className="brand">
        <Logo height={21} />
        <span className="dot">/</span>
        <span className="app-name">Dev Dashboard</span>
      </span>

      <nav className="nav" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="topright">
        <RefreshControl />
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
      </div>
    </header>
  )
}
