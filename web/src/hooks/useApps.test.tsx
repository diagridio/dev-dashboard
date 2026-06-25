import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { useApps, useApp } from './useApps'
import type { AppSummary, AppDetail } from '../types/api'

// Wrap hooks in fresh QueryProvider + RefreshProvider each test to avoid cache contamination
function makeWrapper() {
  const client = makeQueryClient()
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryProvider client={client}>
        <RefreshProvider>{children}</RefreshProvider>
      </QueryProvider>
    )
  }
  return Wrapper
}

const mockApps: AppSummary[] = [
  {
    appId: 'my-app',
    health: 'healthy',
    runtime: 'dapr',
    httpPort: 3500,
    grpcPort: 50001,
    appPort: 8080,
    daprdPid: 1234,
    appPid: 5678,
    cliPid: 9012,
    age: '5m',
    created: '2024-01-01T00:00:00Z',
    runTemplate: 'default',
  },
  {
    appId: 'other-app',
    health: 'starting',
    runtime: 'dapr',
    httpPort: 3501,
    grpcPort: 50002,
    appPort: 8081,
    daprdPid: 1235,
    appPid: 5679,
    cliPid: 9013,
    age: '2m',
    created: '2024-01-01T00:00:00Z',
    runTemplate: '',
  },
]

const mockAppDetail: AppDetail = {
  appId: 'my-app',
  health: 'healthy',
  runtime: 'dapr',
  httpPort: 3500,
  grpcPort: 50001,
  appPort: 8080,
  daprdPid: 1234,
  appPid: 5678,
  cliPid: 9012,
  age: '5m',
  created: '2024-01-01T00:00:00Z',
  runTemplate: 'default',
  resourcePaths: ['/resources'],
  configPath: '/config.yaml',
  appLogPath: '/logs/app.log',
  daprdLogPath: '/logs/daprd.log',
  command: 'node server.js',
  runtimeVersion: '1.14.0',
  metadataOk: true,
}

describe('useApps', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json(mockApps)),
    )
  })

  it('starts in a pending state', () => {
    const { result } = renderHook(() => useApps(), { wrapper: makeWrapper() })
    expect(result.current.isPending).toBe(true)
  })

  it('returns list of apps from /api/apps', async () => {
    const { result } = renderHook(() => useApps(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(2)
    expect(result.current.data![0].appId).toBe('my-app')
    expect(result.current.data![1].appId).toBe('other-app')
  })

  it('returns health field on apps', async () => {
    const { result } = renderHook(() => useApps(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data![0].health).toBe('healthy')
    expect(result.current.data![1].health).toBe('starting')
  })
})

describe('useApp', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/apps/my-app', () => HttpResponse.json(mockAppDetail)),
    )
  })

  it('starts in a pending state', () => {
    const { result } = renderHook(() => useApp('my-app'), { wrapper: makeWrapper() })
    expect(result.current.isPending).toBe(true)
  })

  it('returns detail for a specific app from /api/apps/:id', async () => {
    const { result } = renderHook(() => useApp('my-app'), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data!.appId).toBe('my-app')
    expect(result.current.data!.health).toBe('healthy')
  })

  it('returns extended detail fields', async () => {
    const { result } = renderHook(() => useApp('my-app'), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data!.runTemplate).toBe('default')
    expect(result.current.data!.resourcePaths).toEqual(['/resources'])
    expect(result.current.data!.configPath).toBe('/config.yaml')
    expect(result.current.data!.command).toBe('node server.js')
    expect(result.current.data!.runtimeVersion).toBe('1.14.0')
    expect(result.current.data!.metadataOk).toBe(true)
  })
})
