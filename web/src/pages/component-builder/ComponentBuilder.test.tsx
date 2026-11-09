import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../../test/setup'
import { QueryProvider, makeQueryClient } from '../../lib/query'
import { ComponentBuilder } from './ComponentBuilder'

const bundle = {
  schemaVersion: '1', date: '2026-01-01',
  components: [{ type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
    metadata: [{ name: 'redisHost', required: true }] },
  { type: 'binarystore', name: 'aws.s3', version: 'v1', title: 'AWS S3', status: 'alpha',
    metadata: [{ name: 'bucket', required: true }] }],
}

function renderBuilder() {
  server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
  const router = createMemoryRouter(
    [{ path: '/components/new', element: <ComponentBuilder /> }, { path: '/components', element: <div>components list</div> }],
    { initialEntries: ['/components/new'], future: { v7_relativeSplatPath: true } },
  )
  return render(<QueryProvider client={makeQueryClient()}><RouterProvider router={router} future={{ v7_startTransition: true }} /></QueryProvider>)
}

describe('ComponentBuilder', () => {
  it('sets the document title to New component', async () => {
    renderBuilder()
    await waitFor(() => expect(document.title).toBe('New component | Diagrid Dev Dashboard'))
  })

  it('walks type → (auth) → configure → preview and shows generated YAML', async () => {
    renderBuilder()
    fireEvent.click(await screen.findByRole('button', { name: 'state' })) // pick category
    fireEvent.click(await screen.findByText('Redis')) // step 0 -> 1
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // step 1 -> 2 (no profiles)
    fireEvent.change(screen.getByLabelText(/^Name\s/i), { target: { value: 'order-store' } })
    fireEvent.change(screen.getByLabelText('redisHost'), { target: { value: 'localhost:6379' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // step 2 -> 3
    // after Continue into Preview:
    // highlighted YAML may be split across spans, so use waitFor on textContent
    await waitFor(() => expect(document.querySelector('pre.code')?.textContent).toContain('kind: Component'))
    const pre = document.querySelector('pre.code') as HTMLPreElement
    expect(pre.textContent).toContain('type: state.redis')
    expect(pre.textContent).toContain('name: order-store')
    expect(screen.getByRole('button', { name: /finish/i })).toBeEnabled()
  })

  it('generates binarystore.aws.s3 YAML', async () => {
    renderBuilder()
    fireEvent.click(await screen.findByRole('button', { name: 'binarystore' }))
    fireEvent.click(await screen.findByText('AWS S3'))
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    fireEvent.change(screen.getByLabelText(/^Name\s/i), { target: { value: 'payloads' } })
    fireEvent.change(screen.getByLabelText('bucket'), { target: { value: 'my-bucket' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    await waitFor(() => expect(document.querySelector('pre.code')?.textContent).toContain('kind: Component'))
    const pre = document.querySelector('pre.code') as HTMLPreElement
    expect(pre.textContent).toContain('type: binarystore.aws.s3')
    expect(pre.textContent).toContain('version: v1')
    expect(pre.textContent).toContain('my-bucket')
  })
})
