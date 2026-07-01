import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import type { MetadataBundle, ComponentMetadataSchema, MetadataField, AuthenticationProfile } from '../types/metadata'

export function useComponentSchemas() {
  const query = useQuery<MetadataBundle>({
    queryKey: ['metadata', 'components'],
    queryFn: () => fetchJSON<MetadataBundle>('/metadata/components'),
    staleTime: 60 * 60 * 1000,
  })
  const schemas = query.data?.components ?? []
  const byType: Record<string, ComponentMetadataSchema[]> = {}
  for (const s of schemas) {
    ;(byType[s.type] ??= []).push(s)
  }
  return { schemas, byType, isLoading: query.isLoading, isError: query.isError }
}

/** Merge schema metadata with the chosen auth-profile metadata, split by required. */
export function activeFields(
  schema: ComponentMetadataSchema,
  authProfile?: AuthenticationProfile,
): { required: MetadataField[]; optional: MetadataField[] } {
  const all: MetadataField[] = [...(schema.metadata ?? []), ...(authProfile?.metadata ?? [])]
  const required = all.filter((f) => f.required)
  const optional = all.filter((f) => !f.required)
  return { required, optional }
}
