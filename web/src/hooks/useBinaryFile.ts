import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'
import type { DaprRef } from '../lib/daprRef'
import { analyzePayload, type LoadedPayload } from '../lib/payloadContent'

export class BinaryFileError extends Error {
  status: number
  size?: number
  constructor(status: number, message: string, size?: number) {
    super(message)
    this.name = 'BinaryFileError'
    this.status = status
    this.size = size
  }
}

async function fetchBinaryFile(appKey: string, ref: DaprRef): Promise<LoadedPayload> {
  const url = apiUrl(
    `/apps/${encodeURIComponent(appKey)}/binarystore/${encodeURIComponent(ref.store)}/file?key=${encodeURIComponent(ref.key)}&size=${ref.size}`,
  )
  const res = await fetch(url)
  if (!res.ok) {
    let message = `request failed (${res.status})`
    let size: number | undefined
    try {
      const body = (await res.json()) as { error?: unknown; size?: unknown }
      if (body && typeof body.error === 'string') message = body.error
      if (body && typeof body.size === 'number') size = body.size
    } catch {
      // unparseable body: keep the generic message
    }
    throw new BinaryFileError(res.status, message, size)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  return analyzePayload(bytes, ref.sha256)
}

/** Load + verify + classify a binary-store payload. Stays idle until `enabled`. */
export function useBinaryFile(
  appKey: string | null,
  ref: DaprRef,
  enabled: boolean,
): UseQueryResult<LoadedPayload, BinaryFileError> {
  return useQuery<LoadedPayload, BinaryFileError>({
    queryKey: ['binaryFile', appKey, ref.store, ref.key],
    queryFn: () => fetchBinaryFile(appKey as string, ref),
    enabled: enabled && appKey !== null,
    retry: false,
    staleTime: Infinity,
  })
}
