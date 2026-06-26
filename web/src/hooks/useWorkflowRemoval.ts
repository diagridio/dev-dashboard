import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'
import type { WorkflowStatus } from '../types/workflow'

export interface RemoveRef { appId: string; instanceId: string; status?: WorkflowStatus }
export interface RemoveResult { instanceId: string; mechanism: string; ok: boolean; error?: string }

async function postPurge(body: { ids: { appId: string; instanceId: string }[]; force: boolean }): Promise<RemoveResult[]> {
  const res = await fetch(apiUrl('/workflows/purge'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`purge failed: ${res.status}`)
  return res.json() as Promise<RemoveResult[]>
}

export function useRemoveWorkflows() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { ids: { appId: string; instanceId: string }[]; force: boolean }) => postPurge(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows'] })
      qc.invalidateQueries({ queryKey: ['workflow'] })
    },
  })
}
