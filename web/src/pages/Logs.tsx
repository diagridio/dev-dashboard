import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApps, useApp } from '../hooks/useApps'
import { useLogStream } from '../hooks/useLogStream'
import type { LogLine, LogLevel } from '../types/logs'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { parseLogTime } from '../lib/logtime'

// LogSource is wider than the hook's 'daprd' | 'app'; 'both' composes two streams.
type LogSource = 'both' | 'daprd' | 'app'

/** A merged row carries the original LogLine plus its tagged source. */
interface MergedLine {
  line: LogLine
  src: 'daprd' | 'app'
  /** Arrival index across the merged list — used as tiebreaker when timestamps match */
  arrival: number
}

/** Extract a timestamp token from a log line, returning an empty string if none found. */
function extractTime(text: string): string {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/)
  if (iso) return iso[1]
  const hms = text.match(/\b(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\b/)
  if (hms) return hms[1]
  return ''
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
  merged: MergedLine
  search: string
}

function LogRow({ merged, search }: LogRowProps) {
  const { line, src } = merged
  const level = line.level ?? 'info'
  const isError = level === 'error'
  const time = extractTime(line.text)

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
  activeLevels: Set<LogLevel>
  search: string
  following: boolean
  onToggleLevel: (level: LogLevel) => void
  onSearchChange: (s: string) => void
  onFollowToggle: () => void
  onFollowDisengage: () => void
}

const LINE_CAP = 2000

function LogViewerCore({
  appId,
  source,
  activeLevels,
  search,
  following,
  onToggleLevel,
  onSearchChange,
  onFollowToggle,
  onFollowDisengage,
}: LogViewerCoreProps) {
  // Always call both hooks — pass undefined appId for the unused stream so no EventSource opens
  const daprdResult = useLogStream(source === 'app' ? undefined : appId, 'daprd')
  const appResult = useLogStream(source === 'daprd' ? undefined : appId, 'app')

  const scrollRef = useRef<HTMLDivElement>(null)

  // Build the merged list chronologically
  const merged: MergedLine[] = useMemo(() => {
    if (source === 'daprd') {
      return daprdResult.lines.map((line, i) => ({ line, src: 'daprd' as const, arrival: i }))
    }
    if (source === 'app') {
      return appResult.lines.map((line, i) => ({ line, src: 'app' as const, arrival: i }))
    }
    // 'both': tag each stream's lines, merge and sort chronologically
    const dLines: MergedLine[] = daprdResult.lines.map((line, i) => ({
      line,
      src: 'daprd' as const,
      arrival: i * 2,       // interleave arrival order so equal timestamps retain stream order
    }))
    const aLines: MergedLine[] = appResult.lines.map((line, i) => ({
      line,
      src: 'app' as const,
      arrival: i * 2 + 1,
    }))
    const all = [...dLines, ...aLines]
    // Stable sort: primary key = parsed timestamp (ms since midnight), secondary = arrival
    all.sort((a, b) => {
      const ta = parseLogTime(a.line.text)
      const tb = parseLogTime(b.line.text)
      if (ta !== tb) return ta - tb
      return a.arrival - b.arrival
    })
    // Apply line cap after merge
    if (all.length > LINE_CAP) return all.slice(all.length - LINE_CAP)
    return all
  }, [source, daprdResult.lines, appResult.lines])

  const mergedLen = merged.length

  // Auto-scroll to bottom when new lines arrive and follow is on
  useEffect(() => {
    if (!following) return
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight > 0) {
      el.scrollTop = el.scrollHeight
    }
  }, [mergedLen, following])

  const SCROLL_THRESHOLD = 24

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    if (el.scrollHeight === 0) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom > SCROLL_THRESHOLD && following) {
      // User scrolled away from the bottom — pause following
      onFollowDisengage()
    }
  }

  const filtered = merged.filter(({ line }) => {
    const level = line.level ?? 'info'
    if (!activeLevels.has(level)) return false
    if (search && !line.text.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const matchCount = search
    ? merged.filter(({ line }) => line.text.toLowerCase().includes(search.toLowerCase())).length
    : 0

  // Approximate tail size: sum of full buffer line text byte lengths (not filtered view)
  const tailBytes = merged.reduce((acc, { line }) => acc + line.text.length, 0)
  const tailKB = Math.round(tailBytes / 1024)

  return (
    <>
      {/* Log pane */}
      <div className="card" style={{ padding: 0 }}>
        <div
          className="logwin"
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {filtered.map(merged => (
            <LogRow
              key={`${merged.src}-${merged.line.seq}`}
              merged={merged}
              search={search}
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
          {` · tail ${tailKB} KB`}
        </div>
      </div>
    </>
  )
}

function sourceSubtitle(source: LogSource): string {
  if (source === 'daprd') return 'daprd'
  if (source === 'app') return 'application'
  return 'daprd + application'
}

export function Logs() {
  const [searchParams, setSearchParams] = useSearchParams()
  const appId = searchParams.get('app') ?? ''
  const source = (searchParams.get('source') ?? 'both') as LogSource

  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(new Set(ALL_LEVELS))
  const [search, setSearch] = useState('')
  const [following, setFollowing] = useState(true)

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

  function handleFollowToggle() {
    setFollowing(f => !f)
  }

  useDocumentTitle(appId ? `Logs — ${appId}` : 'Logs — Dapr Dev Dashboard')

  const hasPath = app
    ? source === 'app'
      ? !!app.appLogPath
      : source === 'daprd'
        ? !!app.daprdLogPath
        : !!(app.appLogPath || app.daprdLogPath)
    : false

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>Logs</h1>
          {appId && (
            <div className="sub">
              Tailing <span className="mono b">{appId}</span> · {sourceSubtitle(source)}
            </div>
          )}
        </div>
        <div className="live">
          <span className="beat" />
          live tail (SSE)
        </div>
      </div>

      {/* Single unified logbar: app select · source select · lvchips · search · followbtn */}
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
          onClick={handleFollowToggle}
          aria-pressed={following}
        >
          {following && <span className="d" />}
          {following ? 'Following' : 'Follow'}
        </button>
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
        <LogViewerCore
          appId={appId}
          source={source}
          activeLevels={activeLevels}
          search={search}
          following={following}
          onToggleLevel={toggleLevel}
          onSearchChange={setSearch}
          onFollowToggle={handleFollowToggle}
          onFollowDisengage={() => setFollowing(false)}
        />
      )}

      <p className="hint">
        Logs are read from the run-template log files (<span className="mono">~/.dapr/logs/…</span>
        ). Level chips &amp; search filter live; search matches are highlighted.
      </p>
    </div>
  )
}
