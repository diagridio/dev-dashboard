import { useState, useEffect, useRef, useCallback } from 'react'
import { apiUrl } from '../lib/api'
import { parseLogLevel } from '../lib/loglevel'
import type { LogLine } from '../types/logs'

type Status = 'idle' | 'connecting' | 'open' | 'error'

interface UseLogStreamResult {
  lines: LogLine[]
  status: Status
  clear: () => void
}

export function useLogStream(
  appId: string | undefined,
  source: 'daprd' | 'app',
  opts?: { max?: number }
): UseLogStreamResult {
  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const seqRef = useRef(0)
  // Keep max current via a ref so changes don't tear down the EventSource connection
  const maxRef = useRef(opts?.max ?? 2000)
  maxRef.current = opts?.max ?? 2000

  const clear = useCallback(() => setLines([]), [])

  useEffect(() => {
    if (!appId) {
      setStatus('idle')
      setLines([])
      return
    }

    setStatus('connecting')
    setLines([])

    const url = apiUrl('/apps/' + appId + '/logs?source=' + source)
    // Use the global EventSource constructor so tests can stub it via globalThis.EventSource
    const ESConstructor = (globalThis as unknown as { EventSource: new (url: string) => EventSource }).EventSource
    const es = new ESConstructor(url)

    es.onopen = () => {
      setStatus('open')
    }

    es.onmessage = (e: MessageEvent) => {
      const line: LogLine = {
        seq: seqRef.current++,
        text: e.data,
        level: parseLogLevel(e.data),
      }
      const cap = maxRef.current
      setLines(prev => {
        const next = [...prev, line]
        return next.length > cap ? next.slice(next.length - cap) : next
      })
    }

    es.onerror = () => {
      setStatus('error')
    }

    return () => {
      es.close()
    }
  }, [appId, source])

  return { lines, status, clear }
}
