import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useLogStream, usePathLogStream } from './useLogStream'

class FakeES {
  static instances: FakeES[] = []
  url: string; onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null; onopen: (() => void) | null = null
  closed = false
  readyState = 0 // EventSource.CONNECTING
  constructor(url: string) { this.url = url; FakeES.instances.push(this) }
  close() { this.closed = true }
}

beforeEach(() => { FakeES.instances = []; (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES })
afterEach(() => vi.unstubAllGlobals())

describe('useLogStream', () => {
  it('buffers messages with parsed level and closes on unmount', () => {
    const { result, unmount } = renderHook(() => useLogStream('order', 'daprd'))
    const es = FakeES.instances[0]
    expect(es.url).toContain('/api/apps/order/logs?source=daprd')
    act(() => { es.onmessage?.({ data: 'level=error boom' }) })
    expect(result.current.lines).toHaveLength(1)
    expect(result.current.lines[0].level).toBe('error')
    unmount()
    expect(es.closed).toBe(true)
  })

  it('buffer cap: drops oldest when max is exceeded', () => {
    const { result } = renderHook(() => useLogStream('order', 'daprd', { max: 2 }))
    const es = FakeES.instances[0]
    act(() => {
      es.onmessage?.({ data: 'line1' })
      es.onmessage?.({ data: 'line2' })
      es.onmessage?.({ data: 'line3' })
    })
    expect(result.current.lines).toHaveLength(2)
    expect(result.current.lines[0].text).toBe('line2')
    expect(result.current.lines[1].text).toBe('line3')
  })

  it('revision keeps counting past the buffer cap while lines stay capped', () => {
    const { result } = renderHook(() => useLogStream('order', 'daprd', { max: 3 }))
    const es = FakeES.instances[0]
    act(() => {
      for (let i = 1; i <= 5; i++) es.onmessage?.({ data: `line${i}` })
    })
    // The buffer is capped...
    expect(result.current.lines).toHaveLength(3)
    // ...but revision reflects every line ever received, so consumers keying
    // effects on it (e.g. follow-scroll) still fire after the cap is reached.
    expect(result.current.revision).toBe(5)
    act(() => { es.onmessage?.({ data: 'line6' }) })
    expect(result.current.lines).toHaveLength(3)
    expect(result.current.revision).toBe(6)
  })

  it('status transitions: connecting → open → error', () => {
    const { result } = renderHook(() => useLogStream('order', 'daprd'))
    expect(result.current.status).toBe('connecting')
    const es = FakeES.instances[0]
    act(() => { es.onopen?.() })
    expect(result.current.status).toBe('open')
    act(() => { es.onerror?.() })
    expect(result.current.status).toBe('error')
  })

  it('onerror while reconnecting (readyState CONNECTING) → transient "error"', () => {
    const { result } = renderHook(() => useLogStream('order', 'daprd'))
    const es = FakeES.instances[0]
    act(() => { es.onopen?.() })
    es.readyState = 0 // EventSource.CONNECTING — browser is auto-reconnecting
    act(() => { es.onerror?.() })
    expect(result.current.status).toBe('error')
  })

  it('onerror with readyState CLOSED → terminal "closed"', () => {
    const { result } = renderHook(() => useLogStream('order', 'daprd'))
    const es = FakeES.instances[0]
    act(() => { es.onopen?.() })
    es.readyState = 2 // EventSource.CLOSED — server ended the stream permanently
    act(() => { es.onerror?.() })
    expect(result.current.status).toBe('closed')
  })
})

describe('usePathLogStream', () => {
  it('usePathLogStream connects to the given path', () => {
    const opened: string[] = []
    class FakeES {
      onopen: (() => void) | null = null
      onmessage: ((e: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      constructor(url: string) { opened.push(url) }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
    renderHook(() => usePathLogStream('/controlplane/dapr_scheduler/logs'))
    expect(opened.some((u) => u.includes('/controlplane/dapr_scheduler/logs'))).toBe(true)
  })
})
