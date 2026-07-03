import {
  defaultResiliencyConfig, type DaprResiliency, type RetryPolicy, type CircuitBreakerPolicy,
  type AppTarget, type ActorTarget, type ComponentTarget, type Targets,
} from '../../types/resiliency'
import { validateResourceName } from '../../lib/validation'
import { recursivelyRemoveEmptyValues } from '../../lib/yaml-emit'
import { isDefaultPolicyName } from './defaultPolicies'

export interface ResiliencyState {
  config: DaprResiliency
  activeStep: number
}

export type Action =
  | { type: 'SET_NAME'; name: string }
  | { type: 'SET_NAMESPACE'; namespace: string }
  | { type: 'UPSERT_TIMEOUT'; name: string; duration: string }
  | { type: 'REMOVE_TIMEOUT'; name: string }
  | { type: 'RENAME_TIMEOUT'; from: string; to: string }
  | { type: 'UPSERT_RETRY'; name: string; policy: RetryPolicy }
  | { type: 'REMOVE_RETRY'; name: string }
  | { type: 'RENAME_RETRY'; from: string; to: string }
  | { type: 'UPSERT_CB'; name: string; policy: CircuitBreakerPolicy }
  | { type: 'REMOVE_CB'; name: string }
  | { type: 'RENAME_CB'; from: string; to: string }
  | { type: 'UPSERT_APP'; name: string; target: AppTarget }
  | { type: 'REMOVE_APP'; name: string }
  | { type: 'UPSERT_ACTOR'; name: string; target: ActorTarget }
  | { type: 'REMOVE_ACTOR'; name: string }
  | { type: 'UPSERT_COMPONENT'; name: string; target: ComponentTarget }
  | { type: 'REMOVE_COMPONENT'; name: string }
  | { type: 'NEXT' }
  | { type: 'BACK' }

export function initialState(): ResiliencyState {
  return { config: defaultResiliencyConfig(), activeStep: 0 }
}

/** First free `prefixN` (N >= 1) not already taken — deletions can leave gaps, and
 * counting keys would suggest a name that collides with (and upserts over) an existing one. */
export function nextName(prefix: string, existing: Record<string, unknown>): string {
  for (let i = 1; ; i++) {
    const candidate = `${prefix}${i}`
    if (!(candidate in existing)) return candidate
  }
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map }
  delete next[key]
  return next
}

function renamedKey<T>(map: Record<string, T>, from: string, to: string): Record<string, T> {
  if (!(from in map)) return map
  const next: Record<string, T> = {}
  for (const [k, v] of Object.entries(map)) next[k === from ? to : k] = v
  return next
}

type PolicyField = 'timeout' | 'retry' | 'circuitBreaker'
type PolicyRefs = { timeout?: string; retry?: string; circuitBreaker?: string }

/** Rewrite one target/leg's ref to policy `from`: point it at `to`, or clear it when `to` is undefined. */
function remapRef<T extends PolicyRefs>(leg: T, field: PolicyField, from: string, to?: string): T {
  if (leg[field] !== from) return leg
  if (to !== undefined) return { ...leg, [field]: to }
  const next = { ...leg }
  delete next[field]
  if (field === 'circuitBreaker') {
    // Actor CB settings are meaningless without a circuit breaker (mirrors the dialog).
    delete (next as ActorTarget).circuitBreakerScope
    delete (next as ActorTarget).circuitBreakerCacheSize
  }
  return next
}

function mapValues<T>(map: Record<string, T> | undefined, fn: (v: T) => T): Record<string, T> | undefined {
  if (!map) return map
  let changed = false
  const next: Record<string, T> = {}
  for (const [k, v] of Object.entries(map)) {
    next[k] = fn(v)
    if (next[k] !== v) changed = true
  }
  return changed ? next : map
}

/** Cascade a policy rename (or removal, when `to` is undefined) into every target reference. */
function remapPolicyRefs(targets: Targets, field: PolicyField, from: string, to?: string): Targets {
  const apps = mapValues(targets.apps, (t) => remapRef(t, field, from, to))
  const actors = mapValues(targets.actors, (t) => remapRef(t, field, from, to))
  const components = mapValues(targets.components, (t) => {
    const outbound = t.outbound && remapRef(t.outbound, field, from, to)
    const inbound = t.inbound && remapRef(t.inbound, field, from, to)
    if (outbound === t.outbound && inbound === t.inbound) return t
    const next: ComponentTarget = {}
    if (outbound) next.outbound = outbound
    if (inbound) next.inbound = inbound
    return next
  })
  if (apps === targets.apps && actors === targets.actors && components === targets.components) return targets
  return { ...targets, apps, actors, components }
}

export function reducer(state: ResiliencyState, action: Action): ResiliencyState {
  const cfg = state.config
  const pol = cfg.spec.policies
  const tgt = cfg.spec.targets
  const set = (patch: Partial<DaprResiliency['spec']>): ResiliencyState => ({
    ...state,
    config: { ...cfg, spec: { ...cfg.spec, ...patch } },
  })
  switch (action.type) {
    case 'SET_NAME':
      return { ...state, config: { ...cfg, metadata: { ...cfg.metadata, name: action.name } } }
    case 'SET_NAMESPACE':
      return { ...state, config: { ...cfg, metadata: { ...cfg.metadata, namespace: action.namespace } } }
    case 'UPSERT_TIMEOUT':
      return set({ policies: { ...pol, timeouts: { ...pol.timeouts, [action.name]: action.duration } } })
    case 'REMOVE_TIMEOUT':
      return set({
        policies: { ...pol, timeouts: withoutKey(pol.timeouts, action.name) },
        targets: remapPolicyRefs(tgt, 'timeout', action.name),
      })
    case 'RENAME_TIMEOUT':
      return set({
        policies: { ...pol, timeouts: renamedKey(pol.timeouts, action.from, action.to) },
        targets: remapPolicyRefs(tgt, 'timeout', action.from, action.to),
      })
    case 'UPSERT_RETRY':
      return set({ policies: { ...pol, retries: { ...pol.retries, [action.name]: action.policy } } })
    case 'REMOVE_RETRY':
      return set({
        policies: { ...pol, retries: withoutKey(pol.retries, action.name) },
        targets: remapPolicyRefs(tgt, 'retry', action.name),
      })
    case 'RENAME_RETRY':
      return set({
        policies: { ...pol, retries: renamedKey(pol.retries, action.from, action.to) },
        targets: remapPolicyRefs(tgt, 'retry', action.from, action.to),
      })
    case 'UPSERT_CB':
      return set({ policies: { ...pol, circuitBreakers: { ...pol.circuitBreakers, [action.name]: action.policy } } })
    case 'REMOVE_CB':
      return set({
        policies: { ...pol, circuitBreakers: withoutKey(pol.circuitBreakers, action.name) },
        targets: remapPolicyRefs(tgt, 'circuitBreaker', action.name),
      })
    case 'RENAME_CB':
      return set({
        policies: { ...pol, circuitBreakers: renamedKey(pol.circuitBreakers, action.from, action.to) },
        targets: remapPolicyRefs(tgt, 'circuitBreaker', action.from, action.to),
      })
    case 'UPSERT_APP':
      return set({ targets: { ...tgt, apps: { ...(tgt.apps ?? {}), [action.name]: action.target } } })
    case 'REMOVE_APP':
      return set({ targets: { ...tgt, apps: withoutKey(tgt.apps ?? {}, action.name) } })
    case 'UPSERT_ACTOR':
      return set({ targets: { ...tgt, actors: { ...(tgt.actors ?? {}), [action.name]: action.target } } })
    case 'REMOVE_ACTOR':
      return set({ targets: { ...tgt, actors: withoutKey(tgt.actors ?? {}, action.name) } })
    case 'UPSERT_COMPONENT':
      return set({ targets: { ...tgt, components: { ...(tgt.components ?? {}), [action.name]: action.target } } })
    case 'REMOVE_COMPONENT':
      return set({ targets: { ...tgt, components: withoutKey(tgt.components ?? {}, action.name) } })
    case 'NEXT':
      return { ...state, activeStep: state.activeStep + 1 }
    case 'BACK':
      return { ...state, activeStep: Math.max(0, state.activeStep - 1) }
    default:
      return state
  }
}

function countAll(map: Record<string, unknown> | undefined): number {
  return map ? Object.keys(map).length : 0
}

export function canContinue(state: ResiliencyState): boolean {
  const { config, activeStep } = state
  const { policies, targets } = config.spec
  switch (activeStep) {
    case 0:
      return validateResourceName(config.metadata.name) === null
    case 1:
      return countAll(policies.timeouts) + countAll(policies.retries) + countAll(policies.circuitBreakers) > 0
    case 2: {
      const hasTarget = countAll(targets.apps) + countAll(targets.actors) + countAll(targets.components) > 0
      const hasOverride = Object.keys(policies.retries).some(isDefaultPolicyName)
      return hasTarget || hasOverride
    }
    default:
      return true
  }
}

/** Build the emit object: name (+ namespace if set), no empty scopes, spec cleaned. */
export function assembleResiliency(config: DaprResiliency): Record<string, unknown> {
  const metadata: Record<string, unknown> = { name: config.metadata.name }
  if ((config.metadata.namespace ?? '').trim() !== '') metadata.namespace = config.metadata.namespace
  return {
    apiVersion: config.apiVersion,
    kind: config.kind,
    metadata,
    spec: recursivelyRemoveEmptyValues(config.spec),
  }
}
