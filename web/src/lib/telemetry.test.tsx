import { describe, it, expect, vi, beforeEach } from 'vitest'

const initMock = vi.fn()
const addActionMock = vi.fn()
const addErrorMock = vi.fn()
const startViewMock = vi.fn()

vi.mock('@datadog/browser-rum', () => ({
  datadogRum: {
    init: initMock,
    addAction: addActionMock,
    addError: addErrorMock,
    startView: startViewMock,
  },
}))

beforeEach(() => {
  vi.resetModules()
  initMock.mockClear()
  addActionMock.mockClear()
  addErrorMock.mockClear()
  startViewMock.mockClear()
  delete (window as { __DASH_TELEMETRY_ENABLED__?: boolean }).__DASH_TELEMETRY_ENABLED__
})

describe('initTelemetry', () => {
  it('does not call datadogRum.init when the flag is unset', async () => {
    const { initTelemetry, trackAction } = await import('./telemetry')
    await initTelemetry()
    expect(initMock).not.toHaveBeenCalled()
    trackAction('nav_click', { label: 'Applications' })
    expect(addActionMock).not.toHaveBeenCalled()
  })

  it('does not call datadogRum.init when the flag is false', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = false
    const { initTelemetry } = await import('./telemetry')
    await initTelemetry()
    expect(initMock).not.toHaveBeenCalled()
  })

  it('calls datadogRum.init with the expected config when the flag is true', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    const { initTelemetry } = await import('./telemetry')
    await initTelemetry()
    expect(initMock).toHaveBeenCalledWith({
      applicationId: '80d4832f-54ab-4091-bd92-0d816379b40a',
      clientToken: 'pub566ae9a25b52873b96a28f4075cf6825',
      site: 'datadoghq.com',
      service: 'dev-dashboard',
      env: 'prod',
      sessionSampleRate: 100,
      sessionReplaySampleRate: 0,
      trackUserInteractions: true,
      trackResources: true,
      trackLongTasks: true,
      defaultPrivacyLevel: 'mask',
      trackViewsManually: true,
    })
  })

  it('delegates trackAction/trackError/trackView to the RUM SDK once enabled', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    const { initTelemetry, trackAction, trackError, trackView } = await import('./telemetry')
    await initTelemetry()

    trackAction('nav_click', { label: 'Applications' })
    expect(addActionMock).toHaveBeenCalledWith('nav_click', { label: 'Applications' })

    trackError('boom')
    expect(addErrorMock).toHaveBeenCalledWith('boom', undefined)

    trackView('Applications')
    expect(startViewMock).toHaveBeenCalledWith('Applications')
  })
})
