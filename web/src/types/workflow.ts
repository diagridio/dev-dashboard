export type WorkflowStatus = 'Pending' | 'Running' | 'Completed' | 'Failed' | 'Terminated' | 'Suspended'

export interface WorkflowSummary {
  appId: string
  instanceId: string
  name: string
  status: WorkflowStatus
  createdAt?: string
  lastUpdatedAt?: string
}

export interface WorkflowHistoryEvent {
  sequenceId: number
  timestamp: string
  type: string
  name?: string
  input?: string
  output?: string
}

export interface WorkflowExecution extends WorkflowSummary {
  input?: string
  output?: string
  customStatus?: string
  replayCount: number
  failureDetails?: { errorType?: string; message?: string }
  history: WorkflowHistoryEvent[]
}

export interface WorkflowListResult {
  items: WorkflowSummary[]
  nextToken?: string
}

export interface StateStore {
  name: string
  type: string
  path: string
  active: boolean
  connection: string
}
