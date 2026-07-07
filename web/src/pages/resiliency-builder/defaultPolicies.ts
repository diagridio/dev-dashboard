import type { RetryPolicy } from '../../types/resiliency'

export interface DefaultPolicyPreset {
  label: string
  policy: 'constant' | 'exponential'
  duration: string
  maxInterval: string
  maxRetries: number
}

/** The four reserved Dapr built-in retry policies. */
export const DEFAULT_DAPR_RETRY_POLICIES: DefaultPolicyPreset[] = [
  { label: 'DaprBuiltInServiceRetries', policy: 'constant', duration: '1s', maxInterval: '', maxRetries: 3 },
  { label: 'DaprBuiltInActorRetries', policy: 'constant', duration: '1s', maxInterval: '', maxRetries: 3 },
  { label: 'DaprBuiltInActorReminderRetries', policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 },
  { label: 'DaprBuiltInInitializationRetries', policy: 'exponential', duration: '10s', maxInterval: '500ms', maxRetries: 3 },
]

/** True for the reserved built-in override keys (they live only in the overrides section). */
export function isDefaultPolicyName(name: string): boolean {
  return name.startsWith('DaprBuiltIn')
}

/** Convert a preset to a RetryPolicy; empty maxInterval becomes undefined so it isn't emitted for constant. */
export function presetToRetryPolicy(p: DefaultPolicyPreset): RetryPolicy {
  return {
    policy: p.policy,
    duration: p.duration,
    maxInterval: p.maxInterval || undefined,
    maxRetries: p.maxRetries,
  }
}
