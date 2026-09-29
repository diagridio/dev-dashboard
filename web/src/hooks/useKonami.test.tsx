import { fireEvent, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useKonami } from './useKonami'

const CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']

function press(keys: string[], target: Window | Element = window) {
  for (const key of keys) fireEvent.keyDown(target, { key })
}

describe('useKonami', () => {
  it('fires once on the full sequence', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    press(CODE)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('accepts upper-case B A', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    press([...CODE.slice(0, 8), 'B', 'A'])
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a wrong key in the middle resets the sequence', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    press([...CODE.slice(0, 5), 'x', ...CODE.slice(5)])
    expect(cb).not.toHaveBeenCalled()
    press(CODE)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('ignores bare modifier keydowns, so Shift+B Shift+A still counts', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    press([...CODE.slice(0, 8), 'Shift', 'B', 'Shift', 'A'])
    expect(cb).toHaveBeenCalledTimes(1)
    press(['Control', 'Alt', 'Meta', ...CODE])
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('ignores auto-repeat keydowns', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    for (const key of CODE) {
      fireEvent.keyDown(window, { key })
      fireEvent.keyDown(window, { key: 'x', repeat: true })
    }
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('tolerates extra leading presses', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    press(['ArrowUp', ...CODE])
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('ignores keys typed into form fields', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    const input = document.createElement('input')
    document.body.appendChild(input)
    press(CODE, input)
    expect(cb).not.toHaveBeenCalled()
    input.remove()
  })

  it('stops listening after unmount', () => {
    const cb = vi.fn()
    const { unmount } = renderHook(() => useKonami(cb))
    unmount()
    press(CODE)
    expect(cb).not.toHaveBeenCalled()
  })
})
