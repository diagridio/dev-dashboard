import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppSummary } from '../types/api'

const setTelemetryContextMock = vi.fn()
const useAppsMock = vi.fn()
const getCapabilitiesMock = vi.fn()

vi.mock('../lib/telemetry', () => ({ setTelemetryContext: setTelemetryContextMock }))
vi.mock('./useApps', () => ({ useApps: useAppsMock }))
vi.mock('../lib/capabilities', () => ({ getCapabilities: getCapabilitiesMock }))

function app(source: AppSummary['source'], isAspire = false): AppSummary {
  return {
    appId: 'a', health: 'healthy', runtime: 'dapr', httpPort: 1, grpcPort: 2,
    appPort: 3, daprdPid: 4, appPid: 5, cliPid: 6, age: '1m',
    created: '2024-01-01T00:00:00Z', runTemplate: '', source, isAspire,
  }
}

beforeEach(() => {
  setTelemetryContextMock.mockClear()
  useAppsMock.mockReset()
  getCapabilitiesMock.mockReset()
})

describe('normalizeModeFilter', () => {
  it("maps empty/undefined to 'all' and passes other values through", async () => {
    const { normalizeModeFilter } = await import('./useModeTelemetry')
    expect(normalizeModeFilter('')).toBe('all')
    expect(normalizeModeFilter(undefined)).toBe('all')
    expect(normalizeModeFilter('compose')).toBe('compose')
  })
})

describe('useModeTelemetry', () => {
  it("sets mode_filter from capabilities ('' -> 'all')", async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useModeTelemetry } = await import('./useModeTelemetry')

    renderHook(() => useModeTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('mode_filter', 'all')
  })

  it('does not set modes before apps have loaded', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: 'compose' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useModeTelemetry } = await import('./useModeTelemetry')

    renderHook(() => useModeTelemetry())

    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('modes', expect.anything())
  })

  it('sets the distinct, sorted set of modes among discovered apps', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({
      data: [app('compose'), app('standalone'), app('compose'), app('standalone', true)],
    })
    const { useModeTelemetry } = await import('./useModeTelemetry')

    renderHook(() => useModeTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('modes', ['aspire', 'compose', 'dapr-run'])
  })

  it('sets an empty modes array when nothing is discovered', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: 'aspire' })
    useAppsMock.mockReturnValue({ data: [] })
    const { useModeTelemetry } = await import('./useModeTelemetry')

    renderHook(() => useModeTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('modes', [])
  })
})
