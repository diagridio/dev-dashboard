export type ServiceStatus = 'running' | 'stopped' | 'kubernetes-only' | 'unknown'

export interface ControlPlaneService {
  name: string
  status: ServiceStatus
  healthy: boolean
  ports: string[]
  memoryBytes: number
  memoryHuman: string
  logPath: string
  actionable: boolean
}

export interface ControlPlaneList {
  runtime: string
  available: boolean
  services: ControlPlaneService[]
}

export type ControlPlaneAction = 'start' | 'stop' | 'restart'
