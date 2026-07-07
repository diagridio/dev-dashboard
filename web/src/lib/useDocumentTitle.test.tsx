import { render, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useDocumentTitle } from './useDocumentTitle'

function TitleSetter({ title }: { title: string }) {
  useDocumentTitle(title)
  return null
}

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'Dapr Dev Dashboard'
  })

  it('sets document.title to the provided value plus the branding suffix', () => {
    render(<TitleSetter title="Actors" />)
    expect(document.title).toBe('Actors | Diagrid Dev Dashboard')
  })

  it('restores the previous title on unmount', () => {
    document.title = 'Original'
    const { unmount } = render(<TitleSetter title="Actors" />)
    expect(document.title).toBe('Actors | Diagrid Dev Dashboard')
    act(() => unmount())
    expect(document.title).toBe('Original')
  })

  it('updates title when prop changes, keeping the suffix', () => {
    const { rerender } = render(<TitleSetter title="Actors" />)
    expect(document.title).toBe('Actors | Diagrid Dev Dashboard')
    rerender(<TitleSetter title="Actors — order" />)
    expect(document.title).toBe('Actors — order | Diagrid Dev Dashboard')
  })
})
