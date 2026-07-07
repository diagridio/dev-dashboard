declare global {
  interface Window {
    __DASH_TELEMETRY_ENABLED__?: boolean
  }
}

type Rum = typeof import('@datadog/browser-rum').datadogRum

let rum: Rum | undefined

/** Loads and initializes Datadog RUM, but only when the server-injected flag
 * is exactly `true`. When disabled, the SDK is never imported. */
export async function initTelemetry(): Promise<void> {
  if (window.__DASH_TELEMETRY_ENABLED__ !== true) return
  const { datadogRum } = await import('@datadog/browser-rum')
  datadogRum.init({
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
  rum = datadogRum
}

export function trackAction(name: string, context?: Record<string, unknown>): void {
  rum?.addAction(name, context)
}

export function trackError(error: unknown, context?: Record<string, unknown>): void {
  rum?.addError(error, context)
}

export function trackView(name: string): void {
  rum?.startView(name)
}
