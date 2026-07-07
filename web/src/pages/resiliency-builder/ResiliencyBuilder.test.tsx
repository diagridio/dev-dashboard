import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { ResiliencyBuilder } from './ResiliencyBuilder'

function renderBuilder() {
  const router = createMemoryRouter(
    [{ path: '/resiliency/new', element: <ResiliencyBuilder /> }, { path: '/resiliency', element: <div>resiliency list</div> }],
    { initialEntries: ['/resiliency/new'], future: { v7_relativeSplatPath: true } },
  )
  return render(<RouterProvider router={router} future={{ v7_startTransition: true }} />)
}

describe('ResiliencyBuilder', () => {
  it('walks general → policies → targets → preview and emits YAML', async () => {
    renderBuilder()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'my-res' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 0->1
    fireEvent.click(screen.getByRole('button', { name: /add timeouts/i }))
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: '30s' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 1->2
    fireEvent.click(screen.getByRole('button', { name: /add apps/i }))
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: 'orders' } })
    fireEvent.change(screen.getByLabelText(/^timeout policy/i), { target: { value: 'timeout1' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 2->3
    await waitFor(() => expect(document.querySelector('pre.code')?.textContent).toContain('kind: Resiliency'))
    expect(document.querySelector('pre.code')?.textContent).toContain('name: my-res')
  })

  it('finishes with only a DaprBuiltIn override (no explicit target) and emits default namespace', async () => {
    renderBuilder()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'my-res' } })
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 0->1
    fireEvent.click(screen.getByRole('button', { name: /add DaprBuiltInServiceRetries/i }))
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 1->2 (policy present)
    fireEvent.click(screen.getByRole('button', { name: /continue/i })) // 2->3 (override satisfies gating)
    await waitFor(() => expect(document.querySelector('pre.code')?.textContent).toContain('kind: Resiliency'))
    const yaml = document.querySelector('pre.code')?.textContent ?? ''
    expect(yaml).toContain('namespace: default')
    expect(yaml).toContain('DaprBuiltInServiceRetries')
  })

  it('sets the document title to New resiliency policy', async () => {
    renderBuilder()
    await waitFor(() => expect(document.title).toBe('New resiliency policy | Diagrid Dev Dashboard'))
  })
})
