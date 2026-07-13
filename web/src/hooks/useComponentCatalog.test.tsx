import { render, screen, waitFor, renderHook } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { useComponentCatalog } from './useComponentCatalog'

const bundle = {
  schemaVersion: 'v1',
  date: '2026-01-01',
  components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
      metadata: [{ name: 'redisHost', required: true, type: 'string' }, { name: 'redisPassword', sensitive: true, type: 'string' }] },
    { type: 'state', name: 'postgresql', version: 'v1', title: 'PostgreSQL', status: 'stable',
      metadata: [{ name: 'connectionString', required: true, sensitive: true, type: 'string' }] },
    { type: 'state', name: 'mongodb', version: 'v1', title: 'MongoDB', status: 'stable', metadata: [] },
    { type: 'pubsub', name: 'redis', version: 'v1', title: 'Redis PubSub', status: 'stable', metadata: [] },
  ],
}

// Bundle that mirrors the real catalog: pg/sqlite have NO top-level connectionString
// (it lives only in authenticationProfiles, which ComponentMetadataSchema omits).
const bundleNoConnStr = {
  schemaVersion: 'v1',
  date: '2026-01-01',
  components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
      metadata: [{ name: 'redisHost', required: true, type: 'string' }] },
    { type: 'state', name: 'postgresql', version: 'v1', title: 'PostgreSQL', status: 'stable',
      metadata: [{ name: 'maxConns', required: false, type: 'number' }] },
    { type: 'state', name: 'sqlite', version: 'v1', title: 'SQLite', status: 'stable',
      metadata: [{ name: 'timeout', required: false, type: 'number' }] },
  ],
}

function Probe() {
  const { schemas, fieldsFor, isLoading } = useComponentCatalog()
  if (isLoading) return <div>loading</div>
  return (
    <div>
      <span data-testid="types">{schemas.map((s) => s.type + '.' + s.name).join(',')}</span>
      <span data-testid="redis-fields">{fieldsFor('state.redis').map((f) => f.name).join(',')}</span>
    </div>
  )
}

function SyntheticProbe() {
  const { fieldsFor, isLoading } = useComponentCatalog()
  if (isLoading) return <div>loading</div>
  const pgFields = fieldsFor('state.postgresql')
  const sqliteFields = fieldsFor('state.sqlite')
  const redisFields = fieldsFor('state.redis')
  const pgConnStr = pgFields.find((f) => f.name === 'connectionString')
  const sqliteConnStr = sqliteFields.find((f) => f.name === 'connectionString')
  return (
    <div>
      <span data-testid="pg-has-conn-str">{pgConnStr ? 'yes' : 'no'}</span>
      <span data-testid="pg-required">{pgConnStr?.required ? 'yes' : 'no'}</span>
      <span data-testid="pg-sensitive">{pgConnStr?.sensitive ? 'yes' : 'no'}</span>
      <span data-testid="sqlite-has-conn-str">{sqliteConnStr ? 'yes' : 'no'}</span>
      <span data-testid="sqlite-required">{sqliteConnStr?.required ? 'yes' : 'no'}</span>
      <span data-testid="sqlite-sensitive">{sqliteConnStr?.sensitive ? 'yes' : 'no'}</span>
      <span data-testid="redis-has-conn-str">{redisFields.some((f) => f.name === 'connectionString') ? 'yes' : 'no'}</span>
    </div>
  )
}

describe('useComponentCatalog', () => {
  it('keeps only supported state.* types and resolves fields', async () => {
    server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
    render(<QueryProvider><Probe /></QueryProvider>)
    // mongodb is supported (kept); pubsub.redis excluded (not state).
    await waitFor(() =>
      expect(screen.getByTestId('types')).toHaveTextContent('state.redis,state.postgresql,state.mongodb'),
    )
    expect(screen.getByTestId('redis-fields')).toHaveTextContent('redisHost,redisPassword')
  })

  it('injects synthetic required connectionString for pg/sqlite but not redis', async () => {
    server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundleNoConnStr)))
    render(<QueryProvider><SyntheticProbe /></QueryProvider>)
    await waitFor(() => expect(screen.getByTestId('pg-has-conn-str')).toHaveTextContent('yes'))
    // postgresql: required + sensitive
    expect(screen.getByTestId('pg-required')).toHaveTextContent('yes')
    expect(screen.getByTestId('pg-sensitive')).toHaveTextContent('yes')
    // sqlite: required but NOT sensitive
    expect(screen.getByTestId('sqlite-has-conn-str')).toHaveTextContent('yes')
    expect(screen.getByTestId('sqlite-required')).toHaveTextContent('yes')
    expect(screen.getByTestId('sqlite-sensitive')).toHaveTextContent('no')
    // redis: no connectionString
    expect(screen.getByTestId('redis-has-conn-str')).toHaveTextContent('no')
  })

  it('keeps schemas and fieldsFor referentially stable across re-renders with the same data', async () => {
    server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
    const client = makeQueryClient()
    const { result, rerender } = renderHook(() => useComponentCatalog(), {
      wrapper: ({ children }: { children: React.ReactNode }) => <QueryProvider client={client}>{children}</QueryProvider>,
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const { schemas, fieldsFor } = result.current
    rerender()
    // consumers memoize on these (e.g. useMemo([allFields])) — they must not be rebuilt per render
    expect(result.current.schemas).toBe(schemas)
    expect(result.current.fieldsFor).toBe(fieldsFor)
  })
})
