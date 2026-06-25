import { createContext, useContext, useState, type ReactNode } from 'react'

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
  const raw = localStorage.getItem(REFRESH_MS_KEY)
  if (raw !== null) {
    const parsed = parseInt(raw, 10)
    if (!isNaN(parsed)) return parsed
  }
  return DEFAULT_INTERVAL_MS
}

function readPaused(): boolean {
  return localStorage.getItem(REFRESH_PAUSED_KEY) === 'true'
}

const RefreshContext = createContext<RefreshCtx | null>(null)

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [intervalMs, setIntervalMs] = useState<number>(readIntervalMs)
  const [paused, setPausedState] = useState<boolean>(readPaused)

  function setInterval(ms: number) {
    localStorage.setItem(REFRESH_MS_KEY, String(ms))
    setIntervalMs(ms)
  }

  function setPaused(value: boolean) {
    localStorage.setItem(REFRESH_PAUSED_KEY, String(value))
    setPausedState(value)
  }

  return (
    <RefreshContext.Provider value={{ intervalMs, paused, setInterval, setPaused }}>
      {children}
    </RefreshContext.Provider>
  )
}

export function useRefreshInterval(): RefreshCtx {
  const ctx = useContext(RefreshContext)
  if (!ctx) throw new Error('useRefreshInterval must be used within a RefreshProvider')
  return ctx
}

/** Returns the refetch interval in ms, or false if paused or interval is 0 (Off). */
export function refetchMs(ctx: Pick<RefreshCtx, 'intervalMs' | 'paused'>): number | false {
  if (ctx.paused || ctx.intervalMs === 0) return false
  return ctx.intervalMs
}
