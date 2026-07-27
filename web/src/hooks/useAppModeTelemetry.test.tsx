import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppSummary } from '../types/api'

const setTelemetryContextMock = vi.fn()
const removeTelemetryContextMock = vi.fn()

vi.mock('../lib/telemetry', () => ({
  setTelemetryContext: setTelemetryContextMock,
  removeTelemetryContext: removeTelemetryContextMock,
}))

type ModeApp = Pick<AppSummary, 'source' | 'isAspire'>

beforeEach(() => {
  setTelemetryContextMock.mockClear()
  removeTelemetryContextMock.mockClear()
})

describe('useAppModeTelemetry', () => {
  it('sets app_mode to the focused app token', async () => {
    const { useAppModeTelemetry } = await import('./useAppModeTelemetry')
    renderHook(({ app }: { app: ModeApp }) => useAppModeTelemetry(app), {
      initialProps: { app: { source: 'compose' } as ModeApp },
    })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_mode', 'compose')
  })

  it('removes app_mode on unmount', async () => {
    const { useAppModeTelemetry } = await import('./useAppModeTelemetry')
    const { unmount } = renderHook(({ app }: { app: ModeApp }) => useAppModeTelemetry(app), {
      initialProps: { app: { source: 'aspire' } as ModeApp },
    })
    unmount()
    expect(removeTelemetryContextMock).toHaveBeenCalledWith('app_mode')
  })

  it('sets nothing for an unknown/absent source', async () => {
    const { useAppModeTelemetry } = await import('./useAppModeTelemetry')
    renderHook(({ app }: { app: ModeApp }) => useAppModeTelemetry(app), {
      initialProps: { app: {} as ModeApp },
    })
    expect(setTelemetryContextMock).not.toHaveBeenCalled()
  })

  it('updates app_mode when the focused app changes', async () => {
    const { useAppModeTelemetry } = await import('./useAppModeTelemetry')
    const { rerender } = renderHook(({ app }: { app: ModeApp }) => useAppModeTelemetry(app), {
      initialProps: { app: { source: 'compose' } as ModeApp },
    })
    rerender({ app: { source: 'standalone' } as ModeApp })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_mode', 'dapr-run')
  })
})
