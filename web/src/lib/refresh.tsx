import { createContext, use, useState, type ReactNode } from 'react'
import { safeGet, safeSet } from './safeStorage'

const REFRESH_MS_KEY = 'devdash.refreshMs'
const REFRESH_PAUSED_KEY = 'devdash.refreshPaused'
const DEFAULT_INTERVAL_MS = 3000

export interface RefreshCtx {
  intervalMs: number
  paused: boolean
  setInterval: (ms: number) => void
  setPaused: (paused: boolean) => void
}

function readIntervalMs(): number {
  const raw = safeGet(REFRESH_MS_KEY)
  if (raw !== null) {
    const parsed = parseInt(raw, 10)
    if (!isNaN(parsed)) return parsed
  }
  return DEFAULT_INTERVAL_MS
}

function readPaused(): boolean {
  return safeGet(REFRESH_PAUSED_KEY) === 'true'
}

export const RefreshContext = createContext<RefreshCtx | null>(null)

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [intervalMs, setIntervalMs] = useState<number>(readIntervalMs)
  const [paused, setPausedState] = useState<boolean>(readPaused)

  function setInterval(ms: number) {
    safeSet(REFRESH_MS_KEY, String(ms))
    setIntervalMs(ms)
  }

  function setPaused(value: boolean) {
    safeSet(REFRESH_PAUSED_KEY, String(value))
    setPausedState(value)
  }

  return (
    <RefreshContext value={{ intervalMs, paused, setInterval, setPaused }}>
      {children}
    </RefreshContext>
  )
}

export function useRefreshInterval(): RefreshCtx {
  const ctx = use(RefreshContext)
  if (!ctx) throw new Error('useRefreshInterval must be used within a RefreshProvider')
  return ctx
}

/** Returns the refetch interval in ms, or false if paused or interval is 0 (Off). */
export function refetchMs(ctx: Pick<RefreshCtx, 'intervalMs' | 'paused'>): number | false {
  if (ctx.paused || ctx.intervalMs === 0) return false
  return ctx.intervalMs
}
