import { useEffect } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Shared modal focus behavior: Escape-to-close, a Tab/Shift+Tab focus trap,
 * initial focus on open, and focus restore to the trigger element on close.
 *
 * @param open           whether the dialog is currently open
 * @param onClose        called when Escape is pressed
 * @param dialogRef      ref to the dialog container element
 * @param initialFocusRef optional ref to the element to focus on open
 *                        (defaults to the dialog container itself)
 */
export function useModalFocus(
  open: boolean,
  onClose: () => void,
  dialogRef: React.RefObject<HTMLElement | null>,
  initialFocusRef?: React.RefObject<HTMLElement | null>,
) {
  // Capture the trigger on open, move focus in, and restore it on close.
  // Kept separate from the key handler so an unstable `onClose` identity
  // can't retrigger capture/restore mid-dialog.
  useEffect(() => {
    if (!open) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const t = setTimeout(() => {
      const target = initialFocusRef?.current ?? dialogRef.current
      target?.focus()
    }, 0)
    return () => {
      clearTimeout(t)
      if (trigger && document.contains(trigger)) trigger.focus()
    }
  }, [open, dialogRef, initialFocusRef])

  // Escape key + Tab focus trap.
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusable.length === 0) {
        // Nothing tabbable: keep focus pinned to the dialog container.
        e.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      const escaped = !dialog.contains(active)
      if (!e.shiftKey && (active === last || escaped)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && (active === first || escaped)) {
        e.preventDefault()
        last.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose, dialogRef])
}
