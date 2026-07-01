import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { useComponentSchemas, activeFields } from './useComponentSchemas'
import type { ComponentMetadataSchema } from '../types/metadata'

const bundle = {
  schemaVersion: '1', date: '2026-01-01',
  components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
      metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' }] },
    { type: 'pubsub', name: 'redis', version: 'v1', title: 'Redis PubSub', status: 'stable', metadata: [] },
  ],
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryProvider client={makeQueryClient()}>{children}</QueryProvider>
}

describe('useComponentSchemas', () => {
  it('returns all schemas grouped by type (no state-only filter)', async () => {
    server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
    const { result } = renderHook(() => useComponentSchemas(), { wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.schemas).toHaveLength(2)
    expect(Object.keys(result.current.byType).sort()).toEqual(['pubsub', 'state'])
    expect(result.current.byType.state[0].name).toBe('redis')
  })
})

describe('activeFields', () => {
  const schema: ComponentMetadataSchema = {
    type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
    metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' }],
  }
  it('splits required vs optional and merges auth-profile fields', () => {
    const { required, optional } = activeFields(schema, {
      title: 'AWS IAM', metadata: [{ name: 'accessKey', required: true, sensitive: true }],
    })
    expect(required.map((f) => f.name).sort()).toEqual(['accessKey', 'redisHost'])
    expect(optional.map((f) => f.name)).toEqual(['enableTLS'])
  })
  it('works with no auth profile', () => {
    const { required, optional } = activeFields(schema)
    expect(required.map((f) => f.name)).toEqual(['redisHost'])
    expect(optional.map((f) => f.name)).toEqual(['enableTLS'])
  })
})
