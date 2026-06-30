import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import type { MetadataBundle, ComponentMetadataSchema, MetadataField } from '../types/metadata'
import { SUPPORTED_STORE_TYPES, implFor } from '../lib/storeTypes'

const SUPPORTED_NAMES = new Set(SUPPORTED_STORE_TYPES.map(implFor))

// connectionString lives in authenticationProfiles for pg/sqlite (which the
// catalog schema omits), so inject it as a synthetic required field. redis uses
// its top-level redisHost and needs no synthetic field.
const SYNTHETIC_REQUIRED: Record<string, MetadataField> = {
  'state.postgresql': {
    name: 'connectionString',
    type: 'string',
    required: true,
    sensitive: true,
    description: 'PostgreSQL connection string',
  },
  'state.sqlite': {
    name: 'connectionString',
    type: 'string',
    required: true,
    description: 'Path or DSN of the SQLite database file',
  },
}

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
    const matches = schemas.filter((s) => s.name === name)
    const chosen = matches.find((s) => s.status === 'stable') ?? matches[0]
    const base = chosen?.metadata ?? []
    const synthetic = SYNTHETIC_REQUIRED[type]
    if (synthetic && !base.some((f) => f.name === synthetic.name)) {
      return [synthetic, ...base]
    }
    return base
  }

  return { schemas, fieldsFor, isLoading: query.isLoading, isError: query.isError }
}
