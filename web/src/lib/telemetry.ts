declare global {
  interface Window {
    __DASH_TELEMETRY_ENABLED__?: boolean
    __DASH_VERSION__?: string
  }
}

type Rum = typeof import('@datadog/browser-rum').datadogRum

let rum: Rum | undefined
const buffered: Array<(r: Rum) => void> = []

/** Runs against the RUM SDK if ready; otherwise buffers until init resolves,
 * or drops permanently if telemetry is disabled. */
function runOrBuffer(fn: (r: Rum) => void): void {
  if (rum) {
    fn(rum)
  } else if (window.__DASH_TELEMETRY_ENABLED__ === true) {
    buffered.push(fn)
  }
}

/** Loads and initializes Datadog RUM, but only when the server-injected flag
 * is exactly `true`. When disabled, the SDK is never imported. */
export async function initTelemetry(): Promise<void> {
  if (window.__DASH_TELEMETRY_ENABLED__ !== true) return
  const { datadogRum } = await import('@datadog/browser-rum')
  const version = window.__DASH_VERSION__
  datadogRum.init({
    applicationId: '80d4832f-54ab-4091-bd92-0d816379b40a',
    clientToken: 'pub566ae9a25b52873b96a28f4075cf6825',
    site: 'datadoghq.com',
    service: 'dev-dashboard',
    env: 'prod',
    // Tag every event with the build version so errors and performance can be
    // segmented by release. Omitted for dev/source builds that report no version.
    ...(version && version !== 'dev' ? { version } : {}),
    sessionSampleRate: 100,
    sessionReplaySampleRate: 0,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    defaultPrivacyLevel: 'mask',
    trackViewsManually: true,
  })
  rum = datadogRum
  for (const fn of buffered) fn(rum)
  buffered.length = 0
}

/** Records a user action, once enabled. Buffered until initTelemetry() has resolved. */
export function trackAction(name: string, context?: Record<string, unknown>): void {
  runOrBuffer((r) => r.addAction(name, context))
}

/** Records an error, once enabled. Buffered until initTelemetry() has resolved. */
export function trackError(error: unknown, context?: Record<string, unknown>): void {
  runOrBuffer((r) => r.addError(error, context))
}

/** Starts a manually-tracked view, once enabled. Buffered until initTelemetry() has resolved. */
export function trackView(name: string): void {
  runOrBuffer((r) => r.startView(name))
}
