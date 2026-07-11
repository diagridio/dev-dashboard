import { useEffect, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import { Logo } from './Logo'
import { ThemeToggle } from './ThemeToggle'
import { RefreshControl } from './RefreshControl'
import type { Theme } from '../lib/prefs'
import { trackAction } from '../lib/telemetry'
import { getCapabilities, type Capabilities } from '../lib/capabilities'

export interface NavItem {
  label: string
  to: string
  cap?: keyof Capabilities
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Applications', to: '/' },
  { label: 'Components', to: '/components' },
  { label: 'Workflows', to: '/workflows', cap: 'workflows' },
  { label: 'Actors', to: '/actors' },
  { label: 'Subscriptions', to: '/subscriptions' },
  { label: 'Resiliency', to: '/resiliency' },
  { label: 'Configurations', to: '/configurations' },
  { label: 'Control Plane', to: '/control-plane', cap: 'controlPlane' },
  { label: 'Logs', to: '/logs', cap: 'logs' },
]

interface TopNavProps {
  theme: Theme
  onThemeChange: (t: Theme) => void
}

export function TopNav({ theme, onThemeChange }: TopNavProps) {
  const headerRef = useRef<HTMLElement>(null)
  const caps = getCapabilities()
  const items = NAV_ITEMS.filter((item) => !item.cap || caps[item.cap])

  // The nav can wrap onto extra rows on narrow/zoomed windows; the fixed
  // sidebar reads --topbar-h to start below the topbar's real height.
  useEffect(() => {
    const el = headerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => {
      document.documentElement.style.setProperty('--topbar-h', `${el.offsetHeight}px`)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--topbar-h')
    }
  }, [])

  return (
    <header className="topbar" ref={headerRef}>
      <span className="brand">
        <Logo height={21} />
        <span className="dot">/</span>
        <span className="app-name">Dev Dashboard</span>
      </span>

      <nav className="nav" aria-label="Primary navigation">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
            onClick={() => trackAction('nav_click', { label: item.label })}
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
