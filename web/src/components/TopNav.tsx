import { NavLink } from 'react-router-dom'
import { Logo } from './Logo'
import { ThemeToggle } from './ThemeToggle'
import { DensityToggle } from './DensityToggle'

export interface NavItem {
  label: string
  path: string
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Applications', path: '/' },
  { label: 'Workflows', path: '/workflows' },
  { label: 'Actors', path: '/actors' },
  { label: 'Subscriptions', path: '/subscriptions' },
  { label: 'Components', path: '/components' },
  { label: 'Configurations', path: '/configurations' },
  { label: 'Logs', path: '/logs' },
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
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            style={({ isActive }) => ({
              padding: '4px 10px',
              borderRadius: 'var(--radius-sm, 4px)',
              textDecoration: 'none',
              fontSize: 'var(--text-sm, 13px)',
              fontWeight: isActive ? 600 : 400,
              color: isActive ? 'var(--text)' : 'var(--text-muted)',
              background: isActive ? 'var(--bg-subtle, rgba(0,0,0,0.06))' : 'transparent',
            })}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2, 8px)' }}>
        <DensityToggle />
        <ThemeToggle />
      </div>
    </header>
  )
}
