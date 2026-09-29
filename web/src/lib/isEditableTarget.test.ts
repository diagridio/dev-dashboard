import { describe, expect, it } from 'vitest'
import { isEditableTarget, isInteractiveTarget } from './isEditableTarget'

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

describe('isInteractiveTarget', () => {
  it.each(['a', 'button', 'input', 'textarea', 'select', 'summary'])('is true for <%s>', (tag) => {
    expect(isInteractiveTarget(document.createElement(tag))).toBe(true)
  })

  it('is true inside a button, a role=button or a dialog', () => {
    for (const html of ['<button><span></span></button>', '<div role="button"><span></span></div>', '<div role="dialog"><div><span></span></div></div>']) {
      const host = document.createElement('div')
      host.innerHTML = html
      document.body.appendChild(host)
      expect(isInteractiveTarget(host.querySelector('span'))).toBe(true)
      host.remove()
    }
  })

  it('is false for plain elements, the window and null', () => {
    const div = document.createElement('div')
    div.tabIndex = 0
    expect(isInteractiveTarget(div)).toBe(false)
    expect(isInteractiveTarget(window)).toBe(false)
    expect(isInteractiveTarget(null)).toBe(false)
  })
})
