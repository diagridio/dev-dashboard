export type WorkflowStatus = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Terminated' | 'Suspended'

export interface WorkflowSummary {
  appId: string
  instanceId: string
  name: string
  status: WorkflowStatus
  parentInstanceId?: string
  createdAt?: string
  lastUpdatedAt?: string
}

export interface WorkflowFailureDetails {
  errorType?: string
  message?: string
  stackTrace?: string
}

export interface WorkflowHistoryEvent {
  sequenceId: number
  timestamp: string
  type: string
  name?: string
  instanceId?: string
  scheduledId?: number // start event's EventId; present on completion/fired events
  input?: string
  output?: string
  failureDetails?: WorkflowFailureDetails
}

export interface WorkflowExecution extends WorkflowSummary {
  input?: string
  output?: string
  customStatus?: string
  replayCount: number
  failureDetails?: WorkflowFailureDetails
  history: WorkflowHistoryEvent[]
}

export interface WorkflowListResult {
  items: WorkflowSummary[]
  nextToken?: string
  // Set when the selected store could not be opened and the items were read
  // from the apps' sidecars instead; holds the reason the store was skipped.
  storeError?: string
  // Apps whose sidecar could not list workflows while no store answered for
  // them, so an empty or short list is not mistaken for "no workflows".
  sidecarErrors?: WorkflowSidecarError[]
}

export interface WorkflowSidecarError {
  appId: string
  error: string
}

export interface WorkflowStats {
  counts: Partial<Record<WorkflowStatus, number>>
  total: number
}

export interface StateStore {
  id: string
  name: string
  type: string
  source: string // 'auto' | 'manual'
  path: string
  active: boolean
  connection: string
  updatedAt?: string
  // Names an unresolved secret reference that will make this store fail to
  // connect. Absent/empty when there is none.
  secretIssue?: string
  // True for a store type the dashboard cannot open directly (e.g.
  // state.sqlserver); its workflows can only be read via the sidecars.
  unsupported?: boolean
}
