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
  delete (window as { __DASH_VERSION__?: string }).__DASH_VERSION__
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
      trackAnonymousUser: true,
      trackUserInteractions: true,
      trackResources: true,
      trackLongTasks: true,
      defaultPrivacyLevel: 'mask',
      trackViewsManually: true,
    })
  })

  it('passes the injected build version to datadogRum.init', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    window.__DASH_VERSION__ = 'v1.2.3'
    const { initTelemetry } = await import('./telemetry')
    await initTelemetry()
    expect(initMock).toHaveBeenCalledWith(expect.objectContaining({ version: 'v1.2.3' }))
  })

  it('omits version for dev/source builds', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    window.__DASH_VERSION__ = 'dev'
    const { initTelemetry } = await import('./telemetry')
    await initTelemetry()
    expect(initMock).toHaveBeenCalledWith(expect.not.objectContaining({ version: expect.anything() }))
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

  it('buffers trackAction calls made before initTelemetry resolves and flushes them in order', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    const { initTelemetry, trackAction } = await import('./telemetry')

    const initPromise = initTelemetry()
    trackAction('app_startup')
    expect(addActionMock).not.toHaveBeenCalled()

    await initPromise

    expect(addActionMock).toHaveBeenCalledWith('app_startup', undefined)
  })

  it('does not buffer calls when telemetry is disabled, so they never flush', async () => {
    const { initTelemetry, trackAction } = await import('./telemetry')

    trackAction('nav_click')
    const initPromise = initTelemetry()
    trackAction('nav_click')
    await initPromise

    expect(addActionMock).not.toHaveBeenCalled()
  })

  it('still calls through directly for trackAction calls made after initTelemetry resolves', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    const { initTelemetry, trackAction } = await import('./telemetry')
    await initTelemetry()

    trackAction('nav_click', { label: 'Applications' })

    expect(addActionMock).toHaveBeenCalledWith('nav_click', { label: 'Applications' })
  })
})
