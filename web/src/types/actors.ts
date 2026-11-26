import type { StateItem } from './state'

/** Why a value could not be read; the UI shows an em dash with this as tooltip. */
export interface Unavailable {
  reason: string
}

export interface Reentrancy {
  enabled: boolean
  maxStackDepth?: number
}

export interface TypeConfig {
  idleTimeout: string
  idleTimeoutDefault: boolean
  reentrancy: Reentrancy
}

/** One row of the Actors page: an actor type hosted by one app instance. */
export interface TypeRow {
  appId: string
  /** routing identity: container name for compose apps, appId otherwise */
  instanceKey: string
  type: string
  count: number
  internal: boolean
  runtimeStatus?: string
  hostReady: boolean
  placement?: string
  config?: TypeConfig
  configUnavailable?: Unavailable
  reminders?: number
  remindersUnavailable?: Unavailable
}

export interface ActorID {
  id: string
  stateKeys: number
  reminders: number
  sources: string[]
}

export interface ActorTypeDetail extends TypeRow {
  ids: ActorID[]
  truncated: boolean
  stateUnavailable?: Unavailable
}

export interface Scheduled {
  name: string
  actorId: string
  dueTime: string
  period: string
  ttl: string
  callback: string
  data: string
  dataEncoding: string
}

export interface ActorDetail {
  appId: string
  instanceKey: string
  type: string
  id: string
  state: StateItem[]
  stateUnavailable?: Unavailable
  reminders: Scheduled[]
  remindersUnavailable?: Unavailable
  timers: Scheduled[]
  timersUnavailable?: Unavailable
  storeId?: string
}

export type InvokeVerb = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface InvokeRequest {
  method: string
  verb: InvokeVerb
  body: string
}

export interface InvokeResult {
  status: number
  durationMs: number
  contentType: string
  body: string
  error?: string
}
