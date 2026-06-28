import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApps, useApp } from '../hooks/useApps'
import { useLogStream } from '../hooks/useLogStream'
import type { LogLine, LogLevel } from '../types/logs'
import { useDocumentTitle } from '../lib/useDocumentTitle'

// LogSource is wider than the hook's 'daprd' | 'app'; 'both' maps to 'daprd' at the stream level.
type LogSource = 'both' | 'daprd' | 'app'

function hookSource(s: LogSource): 'daprd' | 'app' {
  return s === 'app' ? 'app' : 'daprd'
}

/** Extract a timestamp token from a log line, returning an empty string if none found. */
function extractTime(text: string): string {
  // ISO-like: 2006-01-02T15:04:05
  const iso = text.match(/\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/)
  if (iso) return iso[1]
  // HH:MM:SS.mmm standalone
  const hms = text.match(/\b(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\b/)
  if (hms) return hms[1]
  return ''
}

/** Extract the source (daprd / app) from a log line if tagged, else return stream source. */
function extractSrc(text: string, streamSrc: 'daprd' | 'app'): 'daprd' | 'app' {
  // logfmt: app_id=... or source=daprd/app
  if (/\bsource=daprd\b/.test(text)) return 'daprd'
  if (/\bsource=app\b/.test(text)) return 'app'
  return streamSrc
}

/** Highlight all occurrences of `query` in `text`. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <span key={i} className="hl">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  )
}

const ALL_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

interface LogRowProps {
  line: LogLine
  search: string
  streamSrc: 'daprd' | 'app'
}

function LogRow({ line, search, streamSrc }: LogRowProps) {
  const level = line.level ?? 'info'
  const isError = level === 'error'
  const time = extractTime(line.text)
  const src = extractSrc(line.text, streamSrc)

  return (
    <div className={`logrow${isError ? ' error' : ''}`}>
      <span className="ltime">{time}</span>
      <span className={`lvl ${level}`}>{level}</span>
      <span className={`lsrc ${src}`}>{src}</span>
      <span className="lmsg">
        <HighlightedText text={line.text} query={search} />
      </span>
    </div>
  )
}

interface LogViewerCoreProps {
  appId: string
  source: LogSource
}

function LogViewerCore({ appId, source }: LogViewerCoreProps) {
  const { lines } = useLogStream(appId, hookSource(source))
  const [search, setSearch] = useState('')
  const [following, setFollowing] = useState(true)
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(new Set(ALL_LEVELS))
  const scrollRef = useRef<HTMLDivElement>(null)
  const linesLen = lines.length

  // Auto-scroll to bottom when new lines arrive and follow is on
  useEffect(() => {
    if (!following) return
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight > 0) {
      el.scrollTop = el.scrollHeight
    }
  }, [linesLen, following])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight === 0) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (nearBottom && !following) {
      setFollowing(true)
    } else if (!nearBottom && following) {
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

  function toggleLevel(level: LogLevel) {
    setActiveLevels(prev => {
      const next = new Set(prev)
      if (next.has(level)) {
        next.delete(level)
      } else {
        next.add(level)
      }
      return next
    })
  }

  const filtered = lines.filter(l => {
    const level = l.level ?? 'info'
    if (!activeLevels.has(level)) return false
    if (search && !l.text.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const matchCount = search
    ? lines.filter(l => l.text.toLowerCase().includes(search.toLowerCase())).length
    : 0

  return (
    <>
      {/* Toolbar */}
      <div className="logbar">
        <div className="lvchips" role="group" aria-label="Levels">
          {ALL_LEVELS.map(level => (
            <button
              key={level}
              className="lvchip"
              aria-pressed={activeLevels.has(level)}
              onClick={() => toggleLevel(level)}
            >
              {level}
            </button>
          ))}
        </div>

        <label className="search">
          🔍
          <input
            data-cy="log-search"
            type="search"
            placeholder="Search…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            aria-label="Filter logs"
          />
        </label>

        <button
          data-cy="log-follow"
          className={`followbtn${following ? ' on' : ''}`}
          onClick={following ? undefined : jumpToLatest}
          aria-pressed={following}
        >
          {following && <span className="d" />}
          {following ? 'Following' : 'Follow'}
        </button>
      </div>

      {/* Log pane */}
      <div className="card" style={{ padding: 0 }}>
        <div
          className="logwin"
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {filtered.map(line => (
            <LogRow
              key={line.seq}
              line={line}
              search={search}
              streamSrc={hookSource(source)}
            />
          ))}
        </div>
        <div className="logfoot">
          <span
            className="beat"
            style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--done-fg)', display: 'inline-block' }}
          />
          {filtered.length} lines
          {search && matchCount > 0 && ` · highlighting "${search}"`}
        </div>
      </div>
    </>
  )
}

export function Logs() {
  const [searchParams, setSearchParams] = useSearchParams()
  const appId = searchParams.get('app') ?? ''
  const source = (searchParams.get('source') ?? 'both') as LogSource

  const { data: apps } = useApps()
  const appIds = (apps ?? []).map(a => a.appId)

  const { data: app, isLoading } = useApp(appId)

  function onAppChange(id: string) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (id) next.set('app', id)
      else next.delete('app')
      return next
    })
  }

  function onSourceChange(s: LogSource) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('source', s)
      return next
    })
  }

  useDocumentTitle(appId ? `Logs — ${appId}` : 'Logs — Dapr Dev Dashboard')

  const hasPath = app
    ? source === 'app'
      ? !!app.appLogPath
      : !!app.daprdLogPath
    : false

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>Logs</h1>
          {appId && (
            <div className="sub">
              Tailing <span className="mono b">{appId}</span> · daprd + application
            </div>
          )}
        </div>
        <div className="live">
          <span className="beat" />
          live tail (SSE)
        </div>
      </div>

      {/* Logbar — always visible for app/source selection */}
      <div className="logbar">
        <select
          className="select"
          data-cy="log-app"
          value={appId}
          onChange={e => onAppChange(e.target.value)}
          aria-label="App"
        >
          <option value="">— select app —</option>
          {appIds.map(id => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>

        <select
          className="select"
          data-cy="log-source"
          value={source}
          onChange={e => onSourceChange(e.target.value as LogSource)}
          aria-label="Source"
        >
          <option value="both">daprd + app</option>
          <option value="daprd">daprd only</option>
          <option value="app">app only</option>
        </select>
      </div>

      {/* Content area */}
      {!appId && (
        <p className="muted">Select an app to view logs.</p>
      )}

      {appId && isLoading && (
        <p className="muted">Loading…</p>
      )}

      {appId && !isLoading && app && !hasPath && (
        <div className="card">
          No log file — this app was started with <code className="mono">dapr run</code> without{' '}
          <code className="mono">-f</code>
        </div>
      )}

      {appId && !isLoading && app && hasPath && (
        <LogViewerCore appId={appId} source={source} />
      )}

      <p className="hint">
        Logs are read from the run-template log files (<span className="mono">~/.dapr/logs/…</span>
        ). Level chips &amp; search filter live; search matches are highlighted.
      </p>
    </div>
  )
}
