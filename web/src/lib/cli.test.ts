import { describe, it, expect } from 'vitest'
import { getCliContent, resolvePlaceholders } from './cli'

const CONTEXTS = ['Applications', 'AppDetail', 'Workflows', 'WorkflowDetail', 'Actors', 'Subscriptions']

describe('getCliContent', () => {
  it('loads content for every supported context with a dapr tool and commands', () => {
    for (const ctx of CONTEXTS) {
      const content = getCliContent(ctx)
      expect(content, ctx).toBeDefined()
      expect(content!.context).toBe(ctx)
      expect(content!.tools.dapr.label).toBe('Dapr')
      expect(content!.tools.dapr.commands.length).toBeGreaterThan(0)
    }
  })

  it('returns undefined for unknown or missing contexts', () => {
    expect(getCliContent('Logs')).toBeUndefined()
    expect(getCliContent(undefined)).toBeUndefined()
  })

  it('ships no Kubernetes-only commands', () => {
    for (const ctx of CONTEXTS) {
      for (const c of getCliContent(ctx)!.tools.dapr.commands) {
        expect(c.command, c.command).not.toMatch(/(^|\s)(-k|--kubernetes)(\s|$)/)
      }
    }
  })

  it('exposes the expected app-detail commands', () => {
    const cmds = getCliContent('AppDetail')!.tools.dapr.commands.map((c) => c.command)
    expect(cmds).toContain('dapr stop --app-id {{appId}}')
  })
})

describe('resolvePlaceholders', () => {
  it('substitutes present values', () => {
    expect(resolvePlaceholders('dapr stop --app-id {{appId}}', { appId: 'order' })).toBe(
      'dapr stop --app-id order',
    )
    expect(
      resolvePlaceholders('dapr workflow history {{instanceId}} --app-id {{appId}}', {
        appId: 'order',
        instanceId: 'abc-123',
      }),
    ).toBe('dapr workflow history abc-123 --app-id order')
  })

  it('falls back to kebab-cased <token> literals for missing/empty values', () => {
    expect(resolvePlaceholders('dapr workflow list --app-id {{appId}}', {})).toBe(
      'dapr workflow list --app-id <app-id>',
    )
    expect(resolvePlaceholders('history {{instanceId}}', { instanceId: '' })).toBe(
      'history <instance-id>',
    )
  })

  it('leaves literal <...> placeholders untouched', () => {
    const cmd = 'dapr invoke --app-id {{appId}} --method <method>'
    expect(resolvePlaceholders(cmd, { appId: 'order' })).toBe(
      'dapr invoke --app-id order --method <method>',
    )
  })
})
