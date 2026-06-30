import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import type { MetadataBundle, ComponentMetadataSchema, MetadataField } from '../types/metadata'
import { SUPPORTED_STORE_TYPES, implFor } from '../lib/storeTypes'

const SUPPORTED_NAMES = new Set(SUPPORTED_STORE_TYPES.map(implFor))

export function useComponentCatalog() {
  const query = useQuery<MetadataBundle>({
    queryKey: ['metadata', 'components'],
    queryFn: () => fetchJSON<MetadataBundle>('/metadata/components'),
    staleTime: 60 * 60 * 1000, // catalog is static + ETag-cached
  })

  const schemas: ComponentMetadataSchema[] = (query.data?.components ?? []).filter(
    (c) => c.type === 'state' && SUPPORTED_NAMES.has(c.name),
  )

  function fieldsFor(type: string): MetadataField[] {
    const name = implFor(type)
    // Prefer a stable entry if multiple versions exist; else first match.
    const matches = schemas.filter((s) => s.name === name)
    const chosen = matches.find((s) => s.status === 'stable') ?? matches[0]
    return chosen?.metadata ?? []
  }

  return { schemas, fieldsFor, isLoading: query.isLoading, isError: query.isError }
}
