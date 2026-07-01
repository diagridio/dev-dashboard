export interface RetryPolicy {
  policy?: 'constant' | 'exponential'
  duration?: string
  maxRetries?: number
  maxInterval?: string
  matching?: { httpStatusCodes?: string; grpcStatusCodes?: string }
}

export interface CircuitBreakerPolicy {
  maxRequests?: number
  timeout?: string
  trip?: string
  interval?: string
}

export type TimeoutPolicy = { [name: string]: string }

export interface Policies {
  timeouts: TimeoutPolicy
  retries: { [name: string]: RetryPolicy }
  circuitBreakers: { [name: string]: CircuitBreakerPolicy }
}

export interface AppTarget {
  timeout?: string
  retry?: string
  circuitBreaker?: string
}

export interface ActorTarget {
  timeout?: string
  retry?: string
  circuitBreaker?: string
  circuitBreakerScope?: 'type' | 'id' | 'both' | ''
  circuitBreakerCacheSize?: number
}

export interface ComponentTarget {
  outbound?: { timeout?: string; retry?: string; circuitBreaker?: string }
  inbound?: { timeout?: string; retry?: string; circuitBreaker?: string }
}

export interface Targets {
  apps?: { [name: string]: AppTarget }
  actors?: { [name: string]: ActorTarget }
  components?: { [name: string]: ComponentTarget }
}

export interface DaprResiliency {
  apiVersion: string
  kind: string
  metadata: { name: string; namespace?: string; [key: string]: unknown }
  scopes: string[]
  spec: { policies: Policies; targets: Targets }
}

export function defaultResiliencyConfig(): DaprResiliency {
  return {
    apiVersion: 'dapr.io/v1alpha1',
    kind: 'Resiliency',
    metadata: { name: '', namespace: '' },
    scopes: [],
    spec: {
      policies: { timeouts: {}, retries: {}, circuitBreakers: {} },
      targets: { apps: {}, actors: {}, components: {} },
    },
  }
}
