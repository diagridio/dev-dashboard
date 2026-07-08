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
}
