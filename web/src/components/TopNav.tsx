import { NavLink } from 'react-router-dom'
import { Logo } from './Logo'
import { ThemeToggle } from './ThemeToggle'
import { DensityToggle } from './DensityToggle'
import { RefreshControl } from './RefreshControl'

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

export function TopNav() {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-4, 16px)',
        padding: '0 var(--space-4, 16px)',
        height: 'var(--nav-height, 52px)',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
        flexShrink: 0,
      }}
    >
      <Logo height={21} />

      <nav
        aria-label="Primary navigation"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1, 4px)',
          flex: 1,
        }}
      >
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            style={({ isActive }) => ({
              padding: '4px 10px',
              borderRadius: 'var(--radius-sm, 4px)',
              textDecoration: 'none',
              fontSize: 'var(--text-sm, 13px)',
              fontWeight: isActive ? 600 : 400,
              color: isActive ? 'var(--text)' : 'var(--text-muted)',
              background: isActive ? 'var(--surface)' : 'transparent',
              boxShadow: isActive ? 'inset 0 0 0 1px var(--border)' : 'none',
            })}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2, 8px)' }}>
        <RefreshControl />
        <DensityToggle />
        <ThemeToggle />
      </div>
    </header>
  )
}
