import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { apiUrl, fetchJSON } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type {
  CreateStatePayload,
  StateDeleteResult,
  StateListResult,
  StateRecord,
  StateWriteError,
} from '../types/state'

interface StateRecordsParams {
  appId?: string
  search?: string
  page?: string
  limit?: number
  store?: string
  includeInternal?: boolean
  enabled?: boolean
}

function queryString(p: StateRecordsParams): string {
  const sp = new URLSearchParams()
  if (p.appId) sp.set('appId', p.appId)
  if (p.search) sp.set('search', p.search)
  if (p.page) sp.set('page', p.page)
  if (p.limit) sp.set('limit', String(p.limit))
  if (p.store) sp.set('store', p.store)
  if (p.includeInternal) sp.set('includeInternal', 'true')
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export function useStateRecords(params: StateRecordsParams) {
  const ctx = useRefreshInterval()
  const qs = queryString(params)
  return useQuery<StateListResult>({
    queryKey: ['state-records', qs],
    queryFn: () => fetchJSON<StateListResult>(`/state${qs}`),
    refetchInterval: refetchMs(ctx),
    enabled: params.enabled !== false,
  })
}

/**
 * One record's full value. Enabled only while its row is expanded, so a wide
 * table never pulls megabytes of values it will not show. Not on the refresh
 * interval: an expanded value is a snapshot the user is reading.
 */
export function useStateRecord(key: string, store?: string, enabled = true) {
  const sp = new URLSearchParams({ key })
  if (store) sp.set('store', store)
  return useQuery<StateRecord>({
    queryKey: ['state-record', key, store],
    queryFn: () => fetchJSON<StateRecord>(`/state/record?${sp.toString()}`),
    enabled: enabled && !!key,
  })
}

/**
 * The selectable key prefixes. includeInternal must mirror the list query's:
 * the server only reports a prefix that has at least one record surviving that
 * filter, so the dropdown never offers an app whose every row is hidden.
 */
export function useStateAppIds(params: {
  store?: string
  includeInternal?: boolean
  enabled?: boolean
}) {
  const ctx = useRefreshInterval()
  const sp = new URLSearchParams()
  if (params.store) sp.set('store', params.store)
  if (params.includeInternal) sp.set('includeInternal', 'true')
  const qs = sp.toString() ? `?${sp.toString()}` : ''
  return useQuery<string[]>({
    queryKey: ['state-appids', qs],
    queryFn: () => fetchJSON<string[]>(`/state/appids${qs}`),
    refetchInterval: refetchMs(ctx),
    enabled: params.enabled !== false,
  })
}

async function postDelete(vars: { keys: string[]; store?: string }): Promise<StateDeleteResult[]> {
  const qs = vars.store ? `?store=${encodeURIComponent(vars.store)}` : ''
  const res = await fetch(apiUrl(`/state/delete${qs}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: vars.keys }),
  })
  if (!res.ok) throw new Error(`delete failed: ${res.status}`)
  return res.json() as Promise<StateDeleteResult[]>
}

/**
 * Everything derived from the keyspace after a write or a delete. The app
 * dropdown is included because a new prefix must appear (and an emptied one
 * disappear); with auto-refresh paused none of it would catch up on its own.
 */
function invalidateKeyspace(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['state-records'] })
  qc.invalidateQueries({ queryKey: ['state-record'] })
  qc.invalidateQueries({ queryKey: ['state-appids'] })
}

export function useDeleteStateRecords() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: postDelete,
    onSuccess: () => invalidateKeyspace(qc),
  })
}

async function postRecord(vars: CreateStatePayload & { store?: string }): Promise<{ key: string }> {
  const { store, ...body } = vars
  const qs = store ? `?store=${encodeURIComponent(store)}` : ''
  const res = await fetch(apiUrl(`/state/record${qs}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let msg = `request failed: ${res.status}`
    try {
      const data = (await res.json()) as { error?: unknown }
      if (data && typeof data.error === 'string') msg = data.error
    } catch {
      // non-JSON body; keep status-only message
    }
    // The status rides along so the caller can tell an existing key (409, which
    // an overwrite can resolve) from a store failure, which it cannot.
    const err: StateWriteError = Object.assign(new Error(msg), { status: res.status })
    throw err
  }
  return res.json() as Promise<{ key: string }>
}

/** Create one record via POST /api/state/record. */
export function useCreateStateRecord() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: postRecord,
    onSuccess: () => invalidateKeyspace(qc),
  })
}
