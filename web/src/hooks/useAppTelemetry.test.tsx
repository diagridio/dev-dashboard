import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppSummary } from '../types/api'

const setTelemetryContextMock = vi.fn()
const removeTelemetryContextMock = vi.fn()

vi.mock('../lib/telemetry', () => ({
  setTelemetryContext: setTelemetryContextMock,
  removeTelemetryContext: removeTelemetryContextMock,
}))

type FocusApp = Pick<AppSummary, 'source' | 'isAspire' | 'runtime'>

beforeEach(() => {
  setTelemetryContextMock.mockClear()
  removeTelemetryContextMock.mockClear()
})

describe('useAppTelemetry — app_mode', () => {
  it('sets app_mode to the focused app token', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { source: 'compose' } as FocusApp },
    })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_mode', 'compose')
  })

  it('removes app_mode on unmount', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    const { unmount } = renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { source: 'aspire' } as FocusApp },
    })
    unmount()
    expect(removeTelemetryContextMock).toHaveBeenCalledWith('app_mode')
  })

  it('sets no app_mode for an unknown/absent source', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: {} as FocusApp },
    })
    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('app_mode', expect.anything())
  })

  it('updates app_mode when the focused app changes', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    const { rerender } = renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { source: 'compose' } as FocusApp },
    })
    rerender({ app: { source: 'standalone' } as FocusApp })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_mode', 'dapr-run')
  })
})

describe('useAppTelemetry — app_runtime', () => {
  it('sets app_runtime to the focused app language token', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { runtime: 'dotnet' } as FocusApp },
    })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_runtime', 'dotnet')
  })

  it('removes app_runtime on unmount', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    const { unmount } = renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { runtime: 'go' } as FocusApp },
    })
    unmount()
    expect(removeTelemetryContextMock).toHaveBeenCalledWith('app_runtime')
  })

  it('sets no app_runtime for an unknown language', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { runtime: 'unknown' } as FocusApp },
    })
    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('app_runtime', expect.anything())
  })

  it('updates app_runtime when the focused app language changes', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    const { rerender } = renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { runtime: 'go' } as FocusApp },
    })
    rerender({ app: { runtime: 'python' } as FocusApp })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_runtime', 'python')
  })
})
