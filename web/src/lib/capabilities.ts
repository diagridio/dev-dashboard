export interface Capabilities {
  lifecycle: boolean
  controlPlane: boolean
  logs: boolean
  workflows: boolean
}

declare global {
  interface Window {
    __DASH_CAPABILITIES__?: Capabilities
  }
}

const FULL: Capabilities = { lifecycle: true, controlPlane: true, logs: true, workflows: true }

// getCapabilities reads the server-injected capability flags. Absent flag
// (Vite dev server, tests) means everything on — matching the host-mode
// server default.
export function getCapabilities(): Capabilities {
  return window.__DASH_CAPABILITIES__ ?? FULL
}
