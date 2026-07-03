import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useLogStream, usePathLogStream } from './useLogStream'

class FakeES {
  static instances: FakeES[] = []
  url: string; onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null; onopen: (() => void) | null = null
  closed = false
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

  it('status transitions: connecting → open → error', () => {
    const { result } = renderHook(() => useLogStream('order', 'daprd'))
    expect(result.current.status).toBe('connecting')
    const es = FakeES.instances[0]
    act(() => { es.onopen?.() })
    expect(result.current.status).toBe('open')
    act(() => { es.onerror?.() })
    expect(result.current.status).toBe('error')
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
