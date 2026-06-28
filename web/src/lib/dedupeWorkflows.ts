import type { WorkflowSummary } from '../types/workflow'

/**
 * Remove duplicate workflows by appId/instanceId, keeping the first occurrence
 * and preserving input order. A safety net against duplicate rows from the API.
 */
export function dedupeWorkflows(items: WorkflowSummary[]): WorkflowSummary[] {
  const seen = new Set<string>()
  const out: WorkflowSummary[] = []
  for (const wf of items) {
    const key = `${wf.appId}/${wf.instanceId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(wf)
  }
  return out
}
