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
    metadata: [{ name: 'redisHost', required: true }] }],
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
  it('walks type → (auth) → configure → preview and shows generated YAML', async () => {
    renderBuilder()
    fireEvent.click(await screen.findByText('Redis')) // step 0 -> 1
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // step 1 -> 2 (no profiles)
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'order-store' } })
    fireEvent.change(screen.getByLabelText('redisHost'), { target: { value: 'localhost:6379' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // step 2 -> 3
    const ta = await screen.findByRole('textbox', { name: /generated yaml/i })
    await waitFor(() => expect((ta as HTMLTextAreaElement).value).toContain('type: state.redis'))
    expect((ta as HTMLTextAreaElement).value).toContain('name: order-store')
  })
})
