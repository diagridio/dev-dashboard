import { describe, it, expect } from 'vitest'
import { dedupeWorkflows } from './dedupeWorkflows'
import type { WorkflowSummary } from '../types/workflow'

function wf(appId: string, instanceId: string, name = 'W'): WorkflowSummary {
  return { appId, instanceId, name, status: 'Running' }
}

describe('dedupeWorkflows', () => {
  it('removes duplicate appId/instanceId pairs, keeping the first occurrence', () => {
    const out = dedupeWorkflows([wf('order', 'a'), wf('order', 'b'), wf('order', 'a')])
    expect(out.map((w) => w.instanceId)).toEqual(['a', 'b'])
  })

  it('keeps same instanceId under different appIds', () => {
    const out = dedupeWorkflows([wf('order', 'a'), wf('cart', 'a')])
    expect(out).toHaveLength(2)
  })

  it('preserves input order', () => {
    const out = dedupeWorkflows([wf('order', 'c'), wf('order', 'a'), wf('order', 'c'), wf('order', 'b')])
    expect(out.map((w) => w.instanceId)).toEqual(['c', 'a', 'b'])
  })
})
