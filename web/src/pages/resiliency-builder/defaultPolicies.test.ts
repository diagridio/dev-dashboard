import { describe, it, expect } from 'vitest'
import { DEFAULT_DAPR_RETRY_POLICIES, isDefaultPolicyName, presetToRetryPolicy } from './defaultPolicies'

describe('DEFAULT_DAPR_RETRY_POLICIES', () => {
  it('has the four Dapr built-in retry policies with documented defaults', () => {
    expect(DEFAULT_DAPR_RETRY_POLICIES).toHaveLength(4)
    const service = DEFAULT_DAPR_RETRY_POLICIES.find((p) => p.label === 'DaprBuiltInServiceRetries')
    expect(service).toEqual({ label: 'DaprBuiltInServiceRetries', policy: 'constant', duration: '1s', maxInterval: '', maxRetries: 3 })
    const reminder = DEFAULT_DAPR_RETRY_POLICIES.find((p) => p.label === 'DaprBuiltInActorReminderRetries')
    expect(reminder).toEqual({ label: 'DaprBuiltInActorReminderRetries', policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 })
  })
})

describe('isDefaultPolicyName', () => {
  it('matches only DaprBuiltIn* names', () => {
    expect(isDefaultPolicyName('DaprBuiltInServiceRetries')).toBe(true)
    expect(isDefaultPolicyName('retry1')).toBe(false)
  })
})

describe('presetToRetryPolicy', () => {
  it('carries duration + maxInterval for exponential presets', () => {
    const reminder = DEFAULT_DAPR_RETRY_POLICIES.find((p) => p.label === 'DaprBuiltInActorReminderRetries')!
    expect(presetToRetryPolicy(reminder)).toEqual({ policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 })
  })
  it('drops empty maxInterval for constant presets', () => {
    const service = DEFAULT_DAPR_RETRY_POLICIES.find((p) => p.label === 'DaprBuiltInServiceRetries')!
    expect(presetToRetryPolicy(service)).toEqual({ policy: 'constant', duration: '1s', maxInterval: undefined, maxRetries: 3 })
  })
})
