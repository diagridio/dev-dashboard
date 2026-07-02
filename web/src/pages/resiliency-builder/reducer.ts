import {
  defaultResiliencyConfig, type DaprResiliency, type RetryPolicy, type CircuitBreakerPolicy,
  type AppTarget, type ActorTarget, type ComponentTarget,
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
  | { type: 'UPSERT_RETRY'; name: string; policy: RetryPolicy }
  | { type: 'REMOVE_RETRY'; name: string }
  | { type: 'UPSERT_CB'; name: string; policy: CircuitBreakerPolicy }
  | { type: 'REMOVE_CB'; name: string }
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

/** `retry1`, `retry2`, ... based on the count of existing keys (matches cloudgrid). */
export function nextName(prefix: string, existing: Record<string, unknown>): string {
  return `${prefix}${Object.keys(existing).length + 1}`
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map }
  delete next[key]
  return next
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
      return set({ policies: { ...pol, timeouts: withoutKey(pol.timeouts, action.name) } })
    case 'UPSERT_RETRY':
      return set({ policies: { ...pol, retries: { ...pol.retries, [action.name]: action.policy } } })
    case 'REMOVE_RETRY':
      return set({ policies: { ...pol, retries: withoutKey(pol.retries, action.name) } })
    case 'UPSERT_CB':
      return set({ policies: { ...pol, circuitBreakers: { ...pol.circuitBreakers, [action.name]: action.policy } } })
    case 'REMOVE_CB':
      return set({ policies: { ...pol, circuitBreakers: withoutKey(pol.circuitBreakers, action.name) } })
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
