import type { Policies, Targets } from './resiliency'

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

export type ResourceKind = 'component' | 'configuration' | 'resiliency'

export type SecretStatus =
  | 'resolved'
  | 'store-not-specified'
  | 'store-not-found'
  | 'store-unsupported'
  | 'store-unreadable'
  | 'key-not-found'
  | 'empty-value'
  | 'forbidden'
  // daprd reads the value from its own environment (local.env store or
  // envRef), which the dashboard can't see: shown without a status.
  | 'not-checked'

export interface SecretRefStatus {
  field: string
  kind: 'secretKeyRef' | 'envRef'
  store?: string
  name?: string
  key?: string
  status: SecretStatus
  detail?: string
}

export interface SecretStoreInfo {
  name: string
  type: string
  file?: string
  prefix?: string
  nestedSeparator?: string
  multiValued?: boolean
  keys?: string[]
  keysCapped?: boolean
  initErr?: string
  usedBy?: string[]
}

export interface ResourceSummary {
  id: string
  name: string
  kind: ResourceKind
  type?: string
  version?: string
  path: string
  loadedBy?: string[]
  scopes?: string[]
  secretRefs?: SecretRefStatus[]
  /** Parsed spec, only on resiliency resources. */
  resiliency?: ResiliencySpec
}

export interface ResourceDetail extends ResourceSummary {
  raw?: string
  secretStore?: SecretStoreInfo
}

/** Spec of a discovered Resiliency file; maps are omitted when empty. */
export interface ResiliencySpec {
  policies: Partial<Policies>
  targets: Targets
}
