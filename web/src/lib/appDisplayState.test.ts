import { describe, it, expect } from 'vitest'
import { appDisplayState } from './appDisplayState'

describe('appDisplayState', () => {
  it('both halves stopped -> grey stopped', () => {
    expect(appDisplayState({ health: 'unknown', appStatus: 'stopped', daprdStatus: 'stopped' }))
      .toEqual({ label: 'stopped', led: 'off' })
  })
  it('orphaned sidecar -> amber orphaned with hint', () => {
    const s = appDisplayState({ health: 'healthy', appStatus: 'stopped', daprdStatus: 'running', sidecarOrphaned: true })
    expect(s.label).toBe('orphaned')
    expect(s.led).toBe('warn')
    expect(s.hint).toBe('sidecar has no supervising dapr CLI and no app — safe to stop')
  })
  it('healthy sidecar but app stopped -> amber app down with hint', () => {
    const s = appDisplayState({ health: 'healthy', appStatus: 'stopped', daprdStatus: 'running' })
    expect(s.label).toBe('app down')
    expect(s.led).toBe('warn')
    expect(s.hint).toBe('app process is not running')
  })
  it('falls back to plain health', () => {
    expect(appDisplayState({ health: 'healthy', appStatus: 'running', daprdStatus: 'running' }))
      .toEqual({ label: 'healthy', led: 'ok' })
    expect(appDisplayState({ health: 'unhealthy' })).toEqual({ label: 'unhealthy', led: 'bad' })
  })
  it('precedence: stopped beats orphaned beats app down', () => {
    expect(appDisplayState({ health: 'unknown', appStatus: 'stopped', daprdStatus: 'stopped', sidecarOrphaned: true }).label)
      .toBe('stopped')
    expect(appDisplayState({ health: 'healthy', appStatus: 'stopped', daprdStatus: 'running', sidecarOrphaned: true }).label)
      .toBe('orphaned')
  })
})
