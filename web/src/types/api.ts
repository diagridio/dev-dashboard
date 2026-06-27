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
  httpPort: number
  grpcPort: number
  appPort: number
  daprdPid: number
  appPid: number
  cliPid: number
  age: string
  created: string
  runTemplate: string
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
  enabledFeatures?: string[]
  actors?: { type: string; count: number }[]
  subscriptions?: { pubsubName: string; topic: string; [key: string]: unknown }[]
  components?: { name: string; type: string; version?: string }[]
  placement?: string
}
