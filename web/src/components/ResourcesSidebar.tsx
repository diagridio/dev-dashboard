import { useCallback, useEffect, useState } from 'react'
import { useNews } from '../hooks/useNews'
import { newsUrls, getSeen, markSeen } from '../lib/newsSeen'
import { useVersion } from '../hooks/useMeta'
import type { NewsResponse, NewsItem } from '../types/logs'
import { trackAction } from '../lib/telemetry'

const STORAGE_KEY = 'devdash.sidebarCollapsed'

/** Inline SVG bell — identical to the mock's #bell-h / #bell-v icon */
function BellIcon() {
  return (
    <svg
      className="bellico"
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4.2 7a3.8 3.8 0 0 1 7.6 0c0 2.6 1 3.6 1.4 4.2H2.8C3.2 10.6 4.2 9.6 4.2 7Z" />
      <path d="M6.4 13a1.6 1.6 0 0 0 3.2 0" />
    </svg>
  )
}

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
    heading: 'Community',
    links: [{ label: 'Dapr Discord', href: 'https://diagrid.ws/dev-dashboard-dapr-discord' }],
  },
  {
    heading: 'Read',
    links: [
      { label: 'Dapr Docs', href: 'https://diagrid.ws/dev-dashboard-dapr-docs' },
      { label: 'Diagrid Docs', href: 'https://diagrid.ws/dev-dashboard-diagrid-docs' },
    ],
  },
  {
    heading: 'Learn',
    links: [
      { label: 'Dapr University', href: 'https://diagrid.ws/dev-dashboard-dapr-university' },
      { label: 'Diagrid Webinars', href: 'https://diagrid.ws/dev-dashboard-webinars' },
    ],
  },
  {
    heading: 'Build',
    links: [
      { label: 'Dapr Workflow Skills', href: 'https://diagrid.ws/dev-dashboard-workflow-skill' },
      { label: 'Workflow Composer', href: 'https://diagrid.ws/dev-dashboard-workflow-composer' },
    ],
  },
  {
    heading: 'Run & Operate',
    links: [
      { label: 'Diagrid Catalyst', href: 'https://diagrid.ws/dev-dashboard-try-catalyst' },
      { label: 'Dapr Support', href: 'https://diagrid.ws/dev-dashboard-dapr-support' },
    ],
  },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Formats an ISO publish date as "Jun 22" (time excluded). Returns undefined if
 * unparseable or if the date is a zero-value sentinel (e.g. Go's "0001-01-01"),
 * which upstream sends for dateless items like reports — those show no date.
 */
function formatPublishDate(iso?: string): string | undefined {
  if (!iso) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) // matches date prefix of YYYY-MM-DD[THH:MM…]
  if (!m) return undefined
  if (Number(m[1]) <= 1) return undefined // zero-value sentinel (year 0000/0001) → no date
  const month = MONTHS[Number(m[2]) - 1]
  if (!month) return undefined
  return `${month} ${Number(m[3])}`
}

/** Subtitle = content type, plus publish date when available (e.g. "Blog · Jun 22"). */
function newsSubtitle(item: NewsItem, label: string): string {
  const date = formatPublishDate(item.publishedAt)
  return date ? `${label} · ${date}` : label
}

const NEWS_SLOTS: Array<{ key: 'blog' | 'report' | 'webinar' | 'event'; label: string }> = [
  { key: 'blog', label: 'Blog' },
  { key: 'webinar', label: 'Webinar' },
  { key: 'report', label: 'Report' },
  { key: 'event', label: 'Event' },
]

interface NewsSectionProps {
  news: NewsResponse
  onMarkSeen: () => void
}

function NewsSection({ news, onMarkSeen }: NewsSectionProps) {
  return (
    <div className="sbsection">
      <div className="sbtitle newstitle">
        <span>News</span>
        {/* Bell visible when panel is open + has-new (CSS-controlled via .app.has-new) */}
        <button
          className="bellbtn"
          id="bell-h"
          onClick={onMarkSeen}
          aria-label="Mark news as seen"
        >
          <BellIcon />
        </button>
      </div>
      {NEWS_SLOTS.map(({ key, label }) => {
        const item = news[key]
        if (!item) return null
        const subtitle = newsSubtitle(item, label)
        return (
          <a
            key={key}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              onMarkSeen()
              trackAction('resource_click', { section: 'News', label: item.title, kind: key })
            }}
            className="sblink"
          >
            <span className="col">
              <span className="txt">{item.title}</span>
              <span className="sub">{subtitle}</span>
            </span>
            <span className="ext">↗</span>
          </a>
        )
      })}
    </div>
  )
}

interface ResourcesSidebarProps {
  collapsed: boolean
  onCollapsedChange: (v: boolean) => void
  onHasNewChange: (v: boolean) => void
}

export function ResourcesSidebar({ collapsed, onCollapsedChange, onHasNewChange }: ResourcesSidebarProps) {
  const [seen, setSeen] = useState<Set<string>>(() => getSeen())
  const { data: news } = useNews()
  const { data: versionData } = useVersion()

  // Derive unseen → bubble up has-new to parent
  const unseen = news != null && newsUrls(news).some((url) => !seen.has(url))
  useEffect(() => {
    onHasNewChange(unseen)
  }, [unseen, onHasNewChange])

  function toggle() {
    const next = !collapsed
    try {
      localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // ignore
    }
    onCollapsedChange(next)
  }

  const handleMarkSeen = useCallback(() => {
    if (!news) return
    const urls = newsUrls(news)
    markSeen(urls)
    setSeen(new Set([...seen, ...urls]))
  }, [news, seen])

  const version = versionData?.version ?? '…'

  return (
    <aside className="sidebar" aria-label="Resources">
      <div className="sbhead">
        <span className="lbl">Resources</span>
        <button
          className="sbtoggle"
          id="sbtoggle"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      <nav className="sbscroll">
        {SECTIONS.map((section) => (
          <div key={section.heading} className="sbsection">
            <div className="sbtitle">{section.heading}</div>
            {section.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="sblink"
                onClick={() => trackAction('resource_click', { section: section.heading, label: link.label })}
              >
                <span className="txt">{link.label}</span>
                <span className="ext">↗</span>
              </a>
            ))}
          </div>
        ))}

        {/* News section */}
        {news && <NewsSection news={news} onMarkSeen={handleMarkSeen} />}
      </nav>

      {/* Collapsed vertical panel */}
      <div className="sbvert" data-testid="sidebar-collapsed-label">
        <button
          className="bellbtn"
          id="bell-v"
          onClick={handleMarkSeen}
          aria-label="Mark news as seen"
        >
          <BellIcon />
        </button>
        <span
          className="vtext"
          onClick={toggle}
          role="button"
          aria-label="Resources — expand sidebar"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle() }}
        >
          Resources
        </span>
      </div>

      <div className="sbfoot">
        <span className="pw">
          Powered by{' '}
          <a
            href="https://diagrid.io/?utm_source=dev-dashboard&utm_medium=footer"
            target="_blank"
            rel="noopener noreferrer"
          >
            Diagrid
          </a>
          {' · '}v{version}
        </span>
        <span className="pw">
          <a
            href="https://github.com/diagridio/dev-dashboard"
            target="_blank"
            rel="noopener noreferrer"
          >
            Issues &amp; feedback
          </a>
        </span>
      </div>
    </aside>
  )
}
