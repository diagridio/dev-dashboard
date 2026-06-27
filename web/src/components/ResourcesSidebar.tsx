import { useState, useCallback } from 'react'
import { useNews } from '../hooks/useNews'
import { newsUrls, getSeen, markSeen } from '../lib/newsSeen'
import type { NewsResponse, NewsItem } from '../types/logs'

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

function newsSubtitle(item: NewsItem, type: 'blog' | 'report' | 'webinar' | 'event'): string | undefined {
  if (type === 'event' || type === 'webinar') {
    const parts: string[] = []
    if (item.eventStartDate) parts.push(item.eventStartDate)
    if (item.eventLocation) parts.push(item.eventLocation)
    if (parts.length > 0) return parts.join(' · ')
  }
  return item.excerpt
}

function emptyStateText(type: 'blog' | 'report' | 'webinar' | 'event'): string {
  switch (type) {
    case 'blog':
      return 'No recent posts'
    case 'report':
      return 'No reports'
    case 'webinar':
      return 'No upcoming webinars'
    case 'event':
      return 'No upcoming events'
  }
}

const NEWS_SLOTS: Array<{ key: 'blog' | 'report' | 'webinar' | 'event'; label: string }> = [
  { key: 'blog', label: 'Blog' },
  { key: 'report', label: 'Report' },
  { key: 'webinar', label: 'Webinar' },
  { key: 'event', label: 'Event' },
]

interface NewsSectionProps {
  news: NewsResponse
  unseen: boolean
  onMarkSeen: () => void
}

function NewsSection({ news, unseen, onMarkSeen }: NewsSectionProps) {
  return (
    <div style={{ marginBottom: 'var(--space-3, 12px)' }}>
      {/* NEWS header with bell */}
      <div
        style={{
          padding: '6px var(--space-3, 12px) 4px',
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--text-faint, #919eab)',
          letterSpacing: '0.08em',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>NEWS</span>
        {unseen && (
          <button
            data-cy="news-bell"
            onClick={onMarkSeen}
            aria-label="Mark news as seen"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              color: 'var(--accent, #0070f3)',
              fontSize: 12,
              lineHeight: 1,
            }}
          >
            🔔
          </button>
        )}
      </div>

      {/* News slots */}
      {NEWS_SLOTS.map(({ key, label }) => {
        const item = news[key]
        if (item) {
          const subtitle = newsSubtitle(item, key)
          return (
            <a
              key={key}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onMarkSeen}
              title={label}
              className="sidebar-link"
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
            >
              <span style={{ display: 'block', fontWeight: 500 }}>{item.title}</span>
              {subtitle && (
                <span
                  style={{
                    display: 'block',
                    fontSize: 11,
                    color: 'var(--text-faint, #919eab)',
                    marginTop: 1,
                  }}
                >
                  {subtitle}
                </span>
              )}
            </a>
          )
        }
        return (
          <div
            key={key}
            style={{
              padding: '5px var(--space-3, 12px)',
              fontSize: 'var(--text-sm, 13px)',
              color: 'var(--text-faint, #919eab)',
              margin: '1px var(--space-2, 8px)',
              fontStyle: 'italic',
            }}
          >
            {emptyStateText(key)}
          </div>
        )
      })}
    </div>
  )
}

export function ResourcesSidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(readInitialCollapsed)
  const [seen, setSeen] = useState<Set<string>>(() => getSeen())
  const { data: news } = useNews()

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

  const handleMarkSeen = useCallback(() => {
    if (!news) return
    const urls = newsUrls(news)
    markSeen(urls)
    setSeen(new Set([...seen, ...urls]))
  }, [news, seen])

  // Derive unseen from news + React state (no localStorage read during render)
  const unseen = news != null && newsUrls(news).some((url) => !seen.has(url))

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
        /* Collapsed state: rotated "Resources" label + bell if unseen, as sibling buttons */
        <div
          data-testid="sidebar-collapsed-label"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          {unseen && (
            <button
              data-cy="news-bell"
              onClick={handleMarkSeen}
              aria-label="Mark news as seen"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                color: 'var(--accent, #0070f3)',
                fontSize: 14,
                lineHeight: 1,
              }}
            >
              🔔
            </button>
          )}
          <button
            onClick={toggle}
            aria-label="Resources — expand sidebar"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '4px 0',
              color: 'var(--text-muted)',
              lineHeight: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
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
          </button>
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
          {/* News section */}
          {news && <NewsSection news={news} unseen={unseen} onMarkSeen={handleMarkSeen} />}

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
                  className="sidebar-link"
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
