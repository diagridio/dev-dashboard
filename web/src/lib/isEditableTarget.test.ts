import { describe, expect, it } from 'vitest'
import { isEditableTarget } from './isEditableTarget'

describe('isEditableTarget', () => {
  it.each(['input', 'textarea', 'select'])('is true for <%s>', (tag) => {
    expect(isEditableTarget(document.createElement(tag))).toBe(true)
  })

  it('is true for contenteditable elements', () => {
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    expect(isEditableTarget(div)).toBe(true)
  })

  it('is false for other elements, the window and null', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(window)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
