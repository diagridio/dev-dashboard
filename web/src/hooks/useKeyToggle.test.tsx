import { act, fireEvent, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useKeyToggle } from './useKeyToggle'

function press(init: KeyboardEventInit, target: Window | Element = window) {
  act(() => {
    fireEvent.keyDown(target, init)
  })
}

describe('useKeyToggle', () => {
  it('starts false', () => {
    expect(renderHook(() => useKeyToggle('b')).result.current).toBe(false)
  })

  it('flips on b and back on the next b', () => {
    const { result } = renderHook(() => useKeyToggle('b'))
    press({ key: 'b' })
    expect(result.current).toBe(true)
    press({ key: 'b' })
    expect(result.current).toBe(false)
  })

  it('accepts upper-case B (Shift / Caps Lock)', () => {
    const { result } = renderHook(() => useKeyToggle('b'))
    press({ key: 'B', shiftKey: true })
    expect(result.current).toBe(true)
  })

  it('ignores other keys', () => {
    const { result } = renderHook(() => useKeyToggle('b'))
    for (const key of ['a', 'x', 'ArrowUp', 'Shift']) press({ key })
    expect(result.current).toBe(false)
  })

  it('ignores b with Ctrl, Meta or Alt held', () => {
    const { result } = renderHook(() => useKeyToggle('b'))
    press({ key: 'b', ctrlKey: true })
    press({ key: 'b', metaKey: true })
    press({ key: 'b', altKey: true })
    expect(result.current).toBe(false)
  })

  it('ignores auto-repeat', () => {
    const { result } = renderHook(() => useKeyToggle('b'))
    press({ key: 'b' })
    for (let i = 0; i < 3; i++) press({ key: 'b', repeat: true })
    expect(result.current).toBe(true)
  })

  it('ignores keys typed into form fields', () => {
    const { result } = renderHook(() => useKeyToggle('b'))
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const fields = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      editable,
    ]
    for (const el of fields) {
      document.body.appendChild(el)
      press({ key: 'b' }, el)
      el.remove()
    }
    expect(result.current).toBe(false)
  })

  it('stops listening after unmount', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useKeyToggle('b'))
    const handler = add.mock.calls.find(([type]) => type === 'keydown')?.[1]
    expect(handler).toBeDefined()
    unmount()
    expect(remove).toHaveBeenCalledWith('keydown', handler)
    add.mockRestore()
    remove.mockRestore()
  })
})
