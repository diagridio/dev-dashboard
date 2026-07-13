import { useCallback, useMemo } from 'react'
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
  // host/server live in the connection profile the catalog omits, so inject
  // host as a synthetic required field (host:port, e.g. localhost:27017).
  'state.mongodb': {
    name: 'host',
    type: 'string',
    required: true,
    description: 'MongoDB host as host:port (e.g. localhost:27017)',
  },
}

// Base catalog fields to promote to required (present in the schema but not
// flagged required there). MongoDB defaults databaseName to "daprStore", but
// inspecting a workflow store requires pointing at the app's actual database.
const REQUIRED_OVERRIDES: Record<string, string[]> = {
  'state.mongodb': ['databaseName'],
}

export function useComponentCatalog() {
  const query = useQuery<MetadataBundle>({
    queryKey: ['metadata', 'components'],
    queryFn: () => fetchJSON<MetadataBundle>('/metadata/components'),
    staleTime: 60 * 60 * 1000, // catalog is static + ETag-cached
  })

  // Memoized on the (ETag-cached, effectively static) query data so consumers'
  // useMemo/useCallback deps actually hit across re-renders.
  const schemas: ComponentMetadataSchema[] = useMemo(
    () => (query.data?.components ?? []).filter((c) => c.type === 'state' && SUPPORTED_NAMES.has(c.name)),
    [query.data],
  )

  const fieldsFor = useCallback((type: string): MetadataField[] => {
    const name = implFor(type)
    const matches = schemas.filter((s) => s.name === name)
    const chosen = matches.find((s) => s.status === 'stable') ?? matches[0]
    const overrides = REQUIRED_OVERRIDES[type] ?? []
    const base = (chosen?.metadata ?? []).map((f) =>
      overrides.includes(f.name) ? { ...f, required: true } : f,
    )
    const synthetic = SYNTHETIC_REQUIRED[type]
    if (synthetic && !base.some((f) => f.name === synthetic.name)) {
      return [synthetic, ...base]
    }
    return base
  }, [schemas])

  return { schemas, fieldsFor, isLoading: query.isLoading, isError: query.isError }
}
