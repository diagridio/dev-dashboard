import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppSummary } from '../types/api'

const setTelemetryContextMock = vi.fn()
const useAppsMock = vi.fn()
const getCapabilitiesMock = vi.fn()

vi.mock('../lib/telemetry', () => ({ setTelemetryContext: setTelemetryContextMock }))
vi.mock('./useApps', () => ({ useApps: useAppsMock }))
vi.mock('../lib/capabilities', () => ({ getCapabilities: getCapabilitiesMock }))

function app(source: AppSummary['source'], isAspire = false, runtime = 'dapr'): AppSummary {
  return {
    appId: 'a', health: 'healthy', runtime, httpPort: 1, grpcPort: 2,
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
    const { normalizeModeFilter } = await import('./useDiscoveryTelemetry')
    expect(normalizeModeFilter('')).toBe('all')
    expect(normalizeModeFilter(undefined)).toBe('all')
    expect(normalizeModeFilter('compose')).toBe('compose')
  })
})

describe('useDiscoveryTelemetry — mode_filter + modes', () => {
  it("sets mode_filter from capabilities ('' -> 'all')", async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('mode_filter', 'all')
  })

  it('does not set modes before apps have loaded', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: 'compose' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('modes', expect.anything())
  })

  it('sets the distinct, sorted set of modes among discovered apps', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({
      data: [app('compose'), app('standalone'), app('compose'), app('standalone', true)],
    })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('modes', ['aspire', 'compose', 'dapr-run'])
  })

  it('sets an empty modes array when nothing is discovered', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: 'aspire' })
    useAppsMock.mockReturnValue({ data: [] })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('modes', [])
  })

  it('avoids re-sending an equivalent modes set on a new apps array reference, but resends when the set changes', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: [app('compose')] })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    const { rerender } = renderHook(() => useDiscoveryTelemetry())
    const modesCalls = () => setTelemetryContextMock.mock.calls.filter((c) => c[0] === 'modes')

    expect(modesCalls()).toHaveLength(1)

    useAppsMock.mockReturnValue({ data: [app('compose')] })
    rerender()
    expect(modesCalls()).toHaveLength(1)

    useAppsMock.mockReturnValue({ data: [app('compose'), app('aspire')] })
    rerender()
    expect(modesCalls()).toHaveLength(2)
  })
})

describe('useDiscoveryTelemetry — runtimes', () => {
  it('does not set runtimes before apps have loaded', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('runtimes', expect.anything())
  })

  it('sets the distinct, sorted set of runtimes among discovered apps', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({
      data: [app('compose', false, 'dotnet'), app('standalone', false, 'go'), app('compose', false, 'dotnet')],
    })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('runtimes', ['dotnet', 'go'])
  })

  it('sets an empty runtimes array when no app language is known', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    // default factory runtime 'dapr' is not a known language -> omitted
    useAppsMock.mockReturnValue({ data: [app('compose'), app('standalone')] })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('runtimes', [])
  })

  it('avoids re-sending an equivalent runtimes set on a new apps array reference, but resends when the set changes', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: [app('compose', false, 'go')] })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    const { rerender } = renderHook(() => useDiscoveryTelemetry())
    const runtimeCalls = () => setTelemetryContextMock.mock.calls.filter((c) => c[0] === 'runtimes')

    expect(runtimeCalls()).toHaveLength(1)

    useAppsMock.mockReturnValue({ data: [app('compose', false, 'go')] })
    rerender()
    expect(runtimeCalls()).toHaveLength(1)

    useAppsMock.mockReturnValue({ data: [app('compose', false, 'go'), app('standalone', false, 'python')] })
    rerender()
    expect(runtimeCalls()).toHaveLength(2)
  })
})
