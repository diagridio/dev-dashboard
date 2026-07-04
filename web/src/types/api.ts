/** Health status of a Dapr application instance */
export type HealthStatus = 'healthy' | 'starting' | 'unhealthy' | 'unknown'

/**
 * Summary fields returned in GET /api/apps (list).
 * Mirrors the Go Instance JSON keys for the list view.
 */
export interface AppSummary {
  appId: string
  health: HealthStatus
  runtime: string
  /** true when the app is .NET Aspire-managed (started by the Aspire host, not a run template) */
  isAspire?: boolean
  /** discovery source: process table vs docker compose containers */
  source?: 'standalone' | 'compose'
  /** compose project name (source === 'compose' only) */
  composeProject?: string
  /** false when a compose sidecar's HTTP port is not published to the host */
  sidecarReachable?: boolean
  httpPort: number
  grpcPort: number
  appPort: number
  daprdPid: number
  appPid: number
  cliPid: number
  age: string
  created: string
  runTemplate: string
  components?: { name: string; type: string; version?: string }[]
}

/**
 * Full detail returned by GET /api/apps/:id.
 * Extends AppSummary with additional fields available in the detail view.
 */
export interface AppDetail extends AppSummary {
  resourcePaths: string[]
  configPath: string
  appLogPath: string
  daprdLogPath: string
  command: string
  runtimeVersion: string
  metadataOk: boolean
  composeService?: string
  daprdContainerId?: string
  daprdContainerName?: string
  appContainerId?: string
  appContainerName?: string
  enabledFeatures?: string[]
  actors?: { type: string; count: number }[]
  subscriptions?: { pubsubName: string; topic: string; [key: string]: unknown }[]
  placement?: string
}
