import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
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

describe('useComponentCatalog', () => {
  it('keeps only supported state.* types and resolves fields', async () => {
    server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
    render(<QueryProvider><Probe /></QueryProvider>)
    // mongodb is filtered out (unsupported); pubsub.redis excluded (not state).
    await waitFor(() => expect(screen.getByTestId('types')).toHaveTextContent('state.redis,state.postgresql'))
    expect(screen.getByTestId('redis-fields')).toHaveTextContent('redisHost,redisPassword')
  })
})
