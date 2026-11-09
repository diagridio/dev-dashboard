export interface Capabilities {
  lifecycle: boolean
  controlPlane: boolean
  logs: boolean
  workflows: boolean
  /** State page (state-store record browser). */
  state?: boolean
  /** Secret reference reveal endpoint (disabled when served off-host). */
  secretReveal?: boolean
  /** CLI --mode value ('' = complete scan); lets the UI adapt static fallbacks. */
  mode?: string
  /**
   * True when the dashboard runs as a container inside the orchestrator it
   * inspects. `mode` cannot express this: it is 'compose' both for a host-run
   * compose scan and for a dashboard running as a compose service.
   */
  containerPosture?: boolean
}

declare global {
  interface Window {
    __DASH_CAPABILITIES__?: Capabilities
  }
}

const FULL: Capabilities = {
  lifecycle: true,
  controlPlane: true,
  logs: true,
  workflows: true,
  state: true,
  secretReveal: true,
  mode: '',
}

// getCapabilities reads the server-injected capability flags. Absent flag
// (Vite dev server, tests) means everything on — matching the host-mode
// server default.
export function getCapabilities(): Capabilities {
  return window.__DASH_CAPABILITIES__ ?? FULL
}
