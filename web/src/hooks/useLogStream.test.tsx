import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useLogStream } from './useLogStream'

class FakeES {
  static instances: FakeES[] = []
  url: string; onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null; onopen: (() => void) | null = null
  closed = false
  constructor(url: string) { this.url = url; FakeES.instances.push(this) }
  close() { this.closed = true }
}

beforeEach(() => { FakeES.instances = []; (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES })

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
})
