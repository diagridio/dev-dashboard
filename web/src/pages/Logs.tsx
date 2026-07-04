import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useApps, useApp } from '../hooks/useApps'
import { useLogStream, usePathLogStream, type LogStreamStatus } from '../hooks/useLogStream'
import { useFollowScroll } from '../hooks/useFollowScroll'
import type { LogLine, LogLevel } from '../types/logs'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { parseLogTime } from '../lib/logtime'
import { parseEnum } from '../lib/parseEnum'

// LogSource is wider than the hook's 'daprd' | 'app'; 'both' composes two streams.
const LOG_SOURCES = ['both', 'daprd', 'app'] as const
type LogSource = (typeof LOG_SOURCES)[number]

const CP_SERVICES = ['dapr_scheduler', 'dapr_placement', 'dapr_sentry', 'dapr_injector'] as const
type CpService = (typeof CP_SERVICES)[number]

/** A merged row carries the original LogLine plus its tagged source. */
interface MergedLine {
  line: LogLine
  src: 'daprd' | 'app'
  /** Arrival index across the merged list — used as tiebreaker when timestamps match */
  arrival: number
  /**
   * Effective time used for chronological sorting. A line without its own clock
   * token inherits the last timestamp seen earlier in the SAME stream so it stays
   * anchored to its neighbours (e.g. the daprd startup banner). Leading lines with
   * no prior timestamp get -Infinity so they sort to the top rather than the bottom.
   */
  sortTime: number
}

/**
 * Tag one stream's lines with source, arrival index, and a carry-forward sortTime.
 * Lines are assumed to be in arrival (chronological) order within the stream.
 */
function tagStream(
  lines: LogLine[],
  src: 'daprd' | 'app',
  arrivalBase: number,
  arrivalStep: number,
): MergedLine[] {
  let last = -Infinity
  return lines.map((line, i) => {
    const t = parseLogTime(line.text)
    if (Number.isFinite(t)) last = t
    return { line, src, arrival: arrivalBase + i * arrivalStep, sortTime: last }
  })
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

/**
 * Sizes the time and source columns to the widest value actually present in the
 * view (monospace, +1 char of breathing room), exposed as the --ltime-w / --lsrc-w
 * CSS variables consumed by .logrow. `srcLabels` are the source tags shown
 * ('daprd'/'app', or a container name); `texts` are the log lines whose extracted
 * timestamps drive the time column. --ltime-w is only set when at least one line
 * carries a timestamp, so the stylesheet default holds for timestamp-less streams.
 */
function logGridVars(srcLabels: string[], texts: string[]): CSSProperties {
  const srcLen = srcLabels.reduce((m, s) => Math.max(m, s.length), 0)
  const timeLen = texts.reduce((m, t) => Math.max(m, extractTime(t).length), 0)
  const vars: Record<string, string> = { '--lsrc-w': `${srcLen + 1}ch` }
  if (timeLen > 0) vars['--ltime-w'] = `${timeLen + 1}ch`
  return vars as CSSProperties
}

/** Level + search filter shared by both viewers. */
function lineMatches(line: LogLine, activeLevels: Set<LogLevel>, search: string): boolean {
  const level = line.level ?? 'info'
  if (!activeLevels.has(level)) return false
  if (search && !line.text.toLowerCase().includes(search.toLowerCase())) return false
  return true
}

/** Search match count over the FULL buffer (not the filtered view). */
function countMatches(lines: LogLine[], search: string): number {
  if (!search) return 0
  return lines.filter(line => line.text.toLowerCase().includes(search.toLowerCase())).length
}

/** Approximate tail size in KB: sum of full-buffer line text lengths (not filtered view). */
function tailSizeKB(lines: LogLine[]): number {
  return Math.round(lines.reduce((acc, line) => acc + line.text.length, 0) / 1024)
}

/**
 * Collapse the statuses of the active streams into a single dot state.
 * Worst-first: terminal 'closed' beats transient 'error', then 'connecting'
 * and 'idle'; the dot shows live only when EVERY active stream is open.
 */
function combineStatuses(statuses: LogStreamStatus[]): LogStreamStatus {
  for (const s of ['closed', 'error', 'connecting', 'idle'] as const) {
    if (statuses.includes(s)) return s
  }
  return 'open'
}

interface LogFootProps {
  status: LogStreamStatus
  lineCount: number
  search: string
  matchCount: number
  tailKB: number
}

/** Shared footer: live-status dot + line count + highlight summary + tail size. */
function LogFoot({ status, lineCount, search, matchCount, tailKB }: LogFootProps) {
  return (
    <div className="logfoot">
      <span
        className={`beatbtn${status === 'open' ? '' : ' off'}`}
        data-status={status}
        title={`stream ${status}`}
        style={{ padding: 0, border: 'none', background: 'transparent', display: 'inline-flex' }}
      >
        <span className="beat" style={{ width: 7, height: 7 }} />
      </span>
      {lineCount} lines
      {search && matchCount > 0 && ` · highlighting "${search}"`}
      {` · tail ${tailKB} KB`}
    </div>
  )
}

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
      <span className={`lsrc lsrc-${src}`}>{src}</span>
      <span className="lmsg">
        <HighlightedText text={line.text} query={search} />
      </span>
    </div>
  )
}

interface CpLogRowProps {
  line: LogLine
  search: string
  service: CpService
}

function CpLogRow({ line, search, service }: CpLogRowProps) {
  const level = line.level ?? 'info'
  const isError = level === 'error'
  const time = extractTime(line.text)

  return (
    <div className={`logrow${isError ? ' error' : ''}`}>
      <span className="ltime">{time}</span>
      <span className={`lvl ${level}`}>{level}</span>
      <span className="lsrc lsrc-cp">{service}</span>
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
  onFollowDisengage: () => void
}

const LINE_CAP = 2000

function LogViewerCore({
  appId,
  source,
  activeLevels,
  search,
  following,
  onFollowDisengage,
}: LogViewerCoreProps) {
  // Always call both hooks — pass undefined appId for the unused stream so no EventSource opens
  const daprdResult = useLogStream(source === 'app' ? undefined : appId, 'daprd')
  const appResult = useLogStream(source === 'daprd' ? undefined : appId, 'app')

  const scrollRef = useRef<HTMLDivElement>(null)

  // Build the merged list chronologically
  const merged: MergedLine[] = useMemo(() => {
    if (source === 'daprd') {
      return tagStream(daprdResult.lines, 'daprd', 0, 1)
    }
    if (source === 'app') {
      return tagStream(appResult.lines, 'app', 0, 1)
    }
    // 'both': tag each stream's lines, merge and sort chronologically.
    // Interleave arrival order (daprd even, app odd) so equal timestamps retain stream order.
    const dLines = tagStream(daprdResult.lines, 'daprd', 0, 2)
    const aLines = tagStream(appResult.lines, 'app', 1, 2)
    const all = [...dLines, ...aLines]
    // Stable sort: primary key = effective (carry-forward) timestamp, secondary = arrival.
    // Guard against Infinity/-Infinity subtraction (which yields NaN) via the equality check.
    all.sort((a, b) => {
      if (a.sortTime !== b.sortTime) return a.sortTime - b.sortTime
      return a.arrival - b.arrival
    })
    // Apply line cap after merge
    if (all.length > LINE_CAP) return all.slice(all.length - LINE_CAP)
    return all
  }, [source, daprdResult.lines, appResult.lines])

  const handleScroll = useFollowScroll(scrollRef, merged.length, following, onFollowDisengage)

  const filtered = merged.filter(({ line }) => lineMatches(line, activeLevels, search))

  const bufferLines = merged.map(m => m.line)
  const matchCount = countMatches(bufferLines, search)
  const tailKB = tailSizeKB(bufferLines)

  // Only the streams the source actually uses count toward the dot
  const status = combineStatuses(
    source === 'daprd'
      ? [daprdResult.status]
      : source === 'app'
        ? [appResult.status]
        : [daprdResult.status, appResult.status],
  )

  return (
    <div className="card" style={{ padding: 0 }}>
      <div
        className="logwin"
        ref={scrollRef}
        onScroll={handleScroll}
        style={logGridVars(source === 'both' ? ['daprd', 'app'] : [source], filtered.map(m => m.line.text))}
      >
        {filtered.map(merged => (
          <LogRow
            key={`${merged.src}-${merged.line.seq}`}
            merged={merged}
            search={search}
          />
        ))}
      </div>
      <LogFoot
        status={status}
        lineCount={filtered.length}
        search={search}
        matchCount={matchCount}
        tailKB={tailKB}
      />
    </div>
  )
}

interface CpLogViewerProps {
  cp: CpService
  activeLevels: Set<LogLevel>
  search: string
  following: boolean
  onFollowDisengage: () => void
}

function CpLogViewer({
  cp,
  activeLevels,
  search,
  following,
  onFollowDisengage,
}: CpLogViewerProps) {
  const { lines, status } = usePathLogStream(`/controlplane/${cp}/logs`)
  const scrollRef = useRef<HTMLDivElement>(null)

  const handleScroll = useFollowScroll(scrollRef, lines.length, following, onFollowDisengage)

  const filtered = lines.filter(line => lineMatches(line, activeLevels, search))
  const matchCount = countMatches(lines, search)
  const tailKB = tailSizeKB(lines)

  return (
    <div className="card" style={{ padding: 0 }}>
      <div
        className="logwin"
        ref={scrollRef}
        onScroll={handleScroll}
        style={logGridVars([cp], filtered.map(l => l.text))}
      >
        {filtered.map(line => (
          <CpLogRow
            key={line.seq}
            line={line}
            search={search}
            service={cp}
          />
        ))}
      </div>
      <LogFoot
        status={status}
        lineCount={filtered.length}
        search={search}
        matchCount={matchCount}
        tailKB={tailKB}
      />
    </div>
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
  // URL params are free-form — validate against the closed sets so
  // ?source=garbage / ?cp=garbage fall back instead of leaking into the UI.
  const source = parseEnum<LogSource>(searchParams.get('source'), LOG_SOURCES, 'both')
  const cp = parseEnum<CpService | ''>(searchParams.get('cp'), CP_SERVICES, '')

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
      // Clear cp when switching to an app
      next.delete('cp')
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

  function onCpChange(name: CpService) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('cp', name)
      // Clear app selection when switching to control-plane view
      next.delete('app')
      return next
    })
  }

  function clearCp() {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('cp')
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

  // cp is already validated against CP_SERVICES above (garbage → '').
  const isCpView = cp !== ''

  useDocumentTitle(
    isCpView
      ? `Logs — ${cp}`
      : appId
        ? `Logs — ${appId}`
        : 'Logs — Dapr Dev Dashboard',
  )

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
          {isCpView && (
            <div className="sub">
              Tailing <span className="mono b">{cp}</span> · control-plane
            </div>
          )}
          {!isCpView && appId && (
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

        {/* Control-plane service selector — slots alongside the existing source selector */}
        <select
          className="select"
          data-cy="log-cp"
          value={cp}
          onChange={e => {
            const val = e.target.value
            if (val === '') clearCp()
            else onCpChange(val as CpService)
          }}
          aria-label="Control Plane"
        >
          <option value="">— control plane —</option>
          {CP_SERVICES.map(name => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
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
      {isCpView && (
        <CpLogViewer
          cp={cp as CpService}
          activeLevels={activeLevels}
          search={search}
          following={following}
          onFollowDisengage={() => setFollowing(false)}
        />
      )}

      {!isCpView && !appId && (
        <p className="muted">Select an app to view logs.</p>
      )}

      {!isCpView && appId && isLoading && (
        <p className="muted">Loading…</p>
      )}

      {!isCpView && appId && !isLoading && app && !hasPath && (
        <div className="card">
          No captured log file — this app streams its logs to the terminal. Redirect{' '}
          <code className="mono">dapr run</code> output to a file, or use a{' '}
          <code className="mono">-f</code> run template, to view logs here.
        </div>
      )}

      {!isCpView && appId && !isLoading && app && hasPath && (
        <LogViewerCore
          appId={appId}
          source={source}
          activeLevels={activeLevels}
          search={search}
          following={following}
          onFollowDisengage={() => setFollowing(false)}
        />
      )}

      <p className="hint">
        Logs are read from run-template files (<span className="mono">~/.dapr/logs/…</span>), .NET Aspire
        captured output, or a redirected <span className="mono">dapr run</span> stdout file. Level chips &amp;
        search filter live; search matches are highlighted.
      </p>
    </div>
  )
}
