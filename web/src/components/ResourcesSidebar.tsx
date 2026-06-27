import { useState } from 'react'

const STORAGE_KEY = 'devdash.sidebarCollapsed'

interface LinkItem {
  label: string
  href: string
}

interface Section {
  heading: string
  links: LinkItem[]
}

const SECTIONS: Section[] = [
  {
    heading: 'BUILD',
    links: [
      { label: 'Dapr Workflow Skills', href: 'https://docs.diagrid.io/develop/workflows/dapr-skills/' },
      { label: 'Dapr Composer', href: 'https://workflows.diagrid.io/' },
    ],
  },
  {
    heading: 'LEARN',
    links: [
      { label: 'Dapr University', href: 'https://www.diagrid.io/university' },
      { label: 'Diagrid Webinars', href: 'https://www.diagrid.io/webinars' },
    ],
  },
  {
    heading: 'READ',
    links: [
      { label: 'Dapr Docs', href: 'https://docs.dapr.io' },
      { label: 'Diagrid Docs', href: 'https://docs.diagrid.io' },
    ],
  },
  {
    heading: 'RUN & OPERATE',
    links: [{ label: 'Diagrid Catalyst', href: 'https://www.diagrid.io/catalyst' }],
  },
]

function readInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function ResourcesSidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(readInitialCollapsed)

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(STORAGE_KEY, String(next))
      } catch {
        // ignore
      }
      return next
    })
  }

  const expandedWidth = 240
  const collapsedWidth = 36

  return (
    <aside
      style={{
        width: collapsed ? collapsedWidth : expandedWidth,
        flexShrink: 0,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Toggle button */}
      <button
        data-cy="sidebar-toggle"
        data-testid="sidebar-toggle"
        onClick={toggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        style={{
          alignSelf: collapsed ? 'center' : 'flex-end',
          margin: collapsed ? '8px auto 0' : '8px 8px 0 0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '4px',
          color: 'var(--text-muted)',
          fontSize: 16,
          lineHeight: 1,
          borderRadius: 'var(--radius-sm, 4px)',
          flexShrink: 0,
        }}
      >
        {collapsed ? '›' : '‹'}
      </button>

      {collapsed ? (
        /* Collapsed state: rotated "Resources" label */
        <div
          data-testid="sidebar-collapsed-label"
          onClick={toggle}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              writingMode: 'vertical-rl',
              transform: 'rotate(-90deg)',
              color: 'var(--text-muted)',
              fontSize: 'var(--text-sm, 13px)',
              fontWeight: 600,
              letterSpacing: '0.05em',
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            Resources
          </span>
        </div>
      ) : (
        /* Expanded state: full link sections */
        <nav
          aria-label="Resources"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 'var(--space-2, 8px) 0',
          }}
        >
          {/* News section — Task 9 */}

          {SECTIONS.map((section) => (
            <div key={section.heading} style={{ marginBottom: 'var(--space-3, 12px)' }}>
              <div
                style={{
                  padding: '6px var(--space-3, 12px) 4px',
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--text-faint, #919eab)',
                  letterSpacing: '0.08em',
                  userSelect: 'none',
                }}
              >
                {section.heading}
              </div>
              {section.links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'block',
                    padding: '5px var(--space-3, 12px)',
                    color: 'var(--text-muted)',
                    textDecoration: 'none',
                    fontSize: 'var(--text-sm, 13px)',
                    borderRadius: 'var(--radius-sm, 4px)',
                    margin: '1px var(--space-2, 8px)',
                    transition: 'background 0.12s, color 0.12s',
                  }}
                  onMouseEnter={(e) => {
                    ;(e.currentTarget as HTMLAnchorElement).style.background = 'var(--border-soft, #eceff2)'
                    ;(e.currentTarget as HTMLAnchorElement).style.color = 'var(--text)'
                  }}
                  onMouseLeave={(e) => {
                    ;(e.currentTarget as HTMLAnchorElement).style.background = 'transparent'
                    ;(e.currentTarget as HTMLAnchorElement).style.color = 'var(--text-muted)'
                  }}
                >
                  {link.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
      )}
    </aside>
  )
}
