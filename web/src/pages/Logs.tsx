import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApps, useApp } from '../hooks/useApps'
import { useLogStream } from '../hooks/useLogStream'
import type { LogLine, LogLevel } from '../types/logs'
import { useDocumentTitle } from '../lib/useDocumentTitle'

// Level → CSS color token
function levelColor(level?: LogLevel): string {
  switch (level) {
    case 'error': return 'var(--bad)'
    case 'warn':  return 'var(--warn)'
    case 'info':  return 'var(--text)'
    case 'debug': return 'var(--text-faint)'
    default:      return 'var(--text)'
  }
}

/** Highlight all occurrences of `query` in `text` using an accent-colored span. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <span
            key={i}
            style={{ background: 'var(--accent)', color: 'var(--text)', borderRadius: 2, padding: '0 1px' }}
          >
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  )
}

function LogLineRow({ line, search }: { line: LogLine; search: string }) {
  return (
    <div
      className="mono"
      style={{
        color: levelColor(line.level),
        fontSize: 12,
        lineHeight: '1.5',
        padding: '0 4px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      <HighlightedText text={line.text} query={search} />
    </div>
  )
}

interface LogViewerProps {
  appId: string
  source: 'daprd' | 'app'
}

function LogViewer({ appId, source }: LogViewerProps) {
  const { lines } = useLogStream(appId, source)
  const [search, setSearch] = useState('')
  const [following, setFollowing] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const linesLen = lines.length

  // Auto-scroll to bottom when new lines arrive and follow is on
  useEffect(() => {
    if (!following) return
    const el = scrollRef.current
    if (!el) return
    // jsdom has no real layout; guard against NaN/0 scrollHeight
    if (el.scrollHeight > 0) {
      el.scrollTop = el.scrollHeight
    }
  }, [linesLen, following])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (!nearBottom && following) {
      setFollowing(false)
    }
  }

  function jumpToLatest() {
    setFollowing(true)
    const el = scrollRef.current
    if (el && el.scrollHeight > 0) {
      el.scrollTop = el.scrollHeight
    }
  }

  const filtered = search
    ? lines.filter(l => l.text.toLowerCase().includes(search.toLowerCase()))
    : lines

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          alignItems: 'center',
          padding: '0 var(--space-2)',
          flexShrink: 0,
        }}
      >
        <input
          data-cy="log-search"
          type="search"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            padding: '4px 8px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--text)',
            fontSize: 13,
            minWidth: 180,
          }}
        />
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', fontSize: 13, color: 'var(--text-faint)' }}
        >
          <input
            data-cy="log-follow"
            type="checkbox"
            checked={following}
            onChange={e => setFollowing(e.target.checked)}
          />
          Follow
        </label>
        {!following && (
          <button
            data-cy="log-jump"
            onClick={jumpToLatest}
            style={{
              padding: '3px 10px',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 4,
              color: 'var(--text)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Jump to latest
          </button>
        )}
      </div>

      {/* Log pane */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: 'auto',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: 'var(--space-2)',
        }}
      >
        {filtered.map(line => (
          <LogLineRow key={line.seq} line={line} search={search} />
        ))}
      </div>
    </div>
  )
}

interface AppPickerProps {
  appIds: string[]
  selectedApp: string
  source: 'daprd' | 'app'
  onAppChange: (app: string) => void
  onSourceChange: (source: 'daprd' | 'app') => void
}

function AppPicker({ appIds, selectedApp, source, onAppChange, onSourceChange }: AppPickerProps) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexShrink: 0 }}>
      <select
        data-cy="log-app"
        value={selectedApp}
        onChange={e => onAppChange(e.target.value)}
        style={{
          padding: '4px 8px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          color: 'var(--text)',
          fontSize: 13,
        }}
      >
        <option value="">— select app —</option>
        {appIds.map(id => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>

      <select
        data-cy="log-source"
        value={source}
        onChange={e => onSourceChange(e.target.value as 'daprd' | 'app')}
        style={{
          padding: '4px 8px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          color: 'var(--text)',
          fontSize: 13,
        }}
      >
        <option value="daprd">daprd</option>
        <option value="app">app</option>
      </select>
    </div>
  )
}

/** Inner component rendered when we have a valid appId; reads app detail. */
function LogsWithApp({
  appId,
  source,
  appIds,
  onAppChange,
  onSourceChange,
}: {
  appId: string
  source: 'daprd' | 'app'
  appIds: string[]
  onAppChange: (app: string) => void
  onSourceChange: (source: 'daprd' | 'app') => void
}) {
  const { data: app, isLoading } = useApp(appId)

  const logPath = app ? (source === 'daprd' ? app.daprdLogPath : app.appLogPath) : undefined
  const hasPath = !!logPath

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4)', color: 'var(--text-faint)' }}>
        Loading…
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
      <AppPicker
        appIds={appIds}
        selectedApp={appId}
        source={source}
        onAppChange={onAppChange}
        onSourceChange={onSourceChange}
      />

      {app && !hasPath ? (
        <div
          style={{
            padding: 'var(--space-4)',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--text-faint)',
            fontSize: 13,
          }}
        >
          No log file — this app was started with <code className="mono">dapr run</code> without{' '}
          <code className="mono">-f</code>
        </div>
      ) : app && hasPath ? (
        <LogViewer appId={appId} source={source} />
      ) : null}
    </div>
  )
}

export function Logs() {
  const [searchParams, setSearchParams] = useSearchParams()
  const appId = searchParams.get('app') ?? ''
  const source = (searchParams.get('source') ?? 'daprd') as 'daprd' | 'app'

  const { data: apps } = useApps()
  const appIds = (apps ?? []).map(a => a.appId)

  function onAppChange(id: string) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (id) next.set('app', id)
      else next.delete('app')
      return next
    })
  }

  function onSourceChange(s: 'daprd' | 'app') {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('source', s)
      return next
    })
  }

  useDocumentTitle(appId ? `Logs — ${appId} (${source})` : 'Logs — Dapr Dev Dashboard')

  if (!appId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
        <AppPicker
          appIds={appIds}
          selectedApp=""
          source={source}
          onAppChange={onAppChange}
          onSourceChange={onSourceChange}
        />
        <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>
          Select an app to view logs.
        </div>
      </div>
    )
  }

  return (
    <LogsWithApp
      appId={appId}
      source={source}
      appIds={appIds}
      onAppChange={onAppChange}
      onSourceChange={onSourceChange}
    />
  )
}
