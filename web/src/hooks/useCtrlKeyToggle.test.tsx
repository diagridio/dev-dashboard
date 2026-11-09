import { act, fireEvent, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCtrlKeyToggle } from './useCtrlKeyToggle'

function press(init: KeyboardEventInit, target: Window | Element = window) {
  let notCancelled = true
  act(() => {
    notCancelled = fireEvent.keyDown(target, init)
  })
  return notCancelled
}

const ctrlB = { key: 'b', ctrlKey: true }

describe('useCtrlKeyToggle', () => {
  it('starts false', () => {
    expect(renderHook(() => useCtrlKeyToggle('b')).result.current).toBe(false)
  })

  it('flips on Ctrl+B and back on the next Ctrl+B', () => {
    const { result } = renderHook(() => useCtrlKeyToggle('b'))
    press(ctrlB)
    expect(result.current).toBe(true)
    press(ctrlB)
    expect(result.current).toBe(false)
  })

  it('ignores a plain b, so the Konami code cannot flip it', () => {
    const { result } = renderHook(() => useCtrlKeyToggle('b'))
    press({ key: 'b' })
    press({ key: 'B', shiftKey: true })
    expect(result.current).toBe(false)
  })

  it('accepts upper-case B (Ctrl+Shift+B / Caps Lock)', () => {
    const { result } = renderHook(() => useCtrlKeyToggle('b'))
    press({ key: 'B', ctrlKey: true, shiftKey: true })
    expect(result.current).toBe(true)
  })

  it('ignores other keys with Ctrl held', () => {
    const { result } = renderHook(() => useCtrlKeyToggle('b'))
    for (const key of ['a', 'x', 'ArrowUp', 'Control']) press({ key, ctrlKey: true })
    expect(result.current).toBe(false)
  })

  it('ignores Cmd+B, Alt+B and Ctrl combined with Cmd or Alt', () => {
    const { result } = renderHook(() => useCtrlKeyToggle('b'))
    press({ key: 'b', metaKey: true })
    press({ key: 'b', altKey: true })
    press({ key: 'b', ctrlKey: true, metaKey: true })
    press({ key: 'b', ctrlKey: true, altKey: true })
    expect(result.current).toBe(false)
  })

  it('cancels the browser default for Ctrl+B only', () => {
    renderHook(() => useCtrlKeyToggle('b'))
    expect(press(ctrlB)).toBe(false)
    expect(press({ key: 'b' })).toBe(true)
  })

  it('ignores auto-repeat', () => {
    const { result } = renderHook(() => useCtrlKeyToggle('b'))
    press(ctrlB)
    for (let i = 0; i < 3; i++) press({ ...ctrlB, repeat: true })
    expect(result.current).toBe(true)
  })

  it('ignores Ctrl+B typed into form fields', () => {
    const { result } = renderHook(() => useCtrlKeyToggle('b'))
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
      press(ctrlB, el)
      el.remove()
    }
    expect(result.current).toBe(false)
  })

  it('stops listening after unmount', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useCtrlKeyToggle('b'))
    const handler = add.mock.calls.find(([type]) => type === 'keydown')?.[1]
    expect(handler).toBeDefined()
    unmount()
    expect(remove).toHaveBeenCalledWith('keydown', handler)
    add.mockRestore()
    remove.mockRestore()
  })
})
