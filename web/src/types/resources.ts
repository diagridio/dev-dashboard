export interface Actor {
  appId: string
  /** routing identity: container name for compose apps, appId otherwise */
  instanceKey?: string
  type: string
  count: number
  placement?: string
}

export interface SubRule {
  match?: string
  path?: string
}

export interface Subscription {
  appId: string
  /** routing identity: container name for compose apps, appId otherwise */
  instanceKey?: string
  pubsubName: string
  topic: string
  rules?: SubRule[]
  deadLetterTopic?: string
  type?: string
  reachable?: boolean
}

export type ResourceKind = 'component' | 'configuration'

export interface ResourceSummary {
  id: string
  name: string
  kind: ResourceKind
  type?: string
  version?: string
  path: string
  loadedBy?: string[]
}

export interface ResourceDetail extends ResourceSummary {
  raw?: string
}
