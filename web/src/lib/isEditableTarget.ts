/** True when a key event comes from somewhere the user is typing text. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable || t.getAttribute('contenteditable') === 'true') return true
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
}

const INTERACTIVE = 'a, button, input, textarea, select, summary, [role="button"], [contenteditable]:not([contenteditable="false"]), [role="dialog"]'

/**
 * True when a key event belongs to something else on the page: a field, a
 * link or button (or anything inside one), or anything inside a dialog.
 */
export function isInteractiveTarget(t: EventTarget | null): boolean {
  if (isEditableTarget(t)) return true
  return t instanceof Element && t.closest(INTERACTIVE) !== null
}
