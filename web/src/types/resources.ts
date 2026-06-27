export interface Actor {
  appId: string
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
  pubsubName: string
  topic: string
  rules?: SubRule[]
  deadLetterTopic?: string
  type?: string
}

export type ResourceKind = 'component' | 'configuration'

export interface ResourceSummary {
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
