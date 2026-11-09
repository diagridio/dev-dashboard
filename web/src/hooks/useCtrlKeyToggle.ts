import { useEffect, useState } from 'react'
import { isEditableTarget } from '../lib/isEditableTarget'

/**
 * A boolean that flips each time Ctrl+`key` is pressed anywhere outside a form
 * field. The letter is case-insensitive, so Shift may be held too; a plain
 * `key`, Cmd/Alt chords and auto-repeat are ignored. The browser default for
 * the chord (e.g. Firefox's Ctrl+B bookmarks sidebar) is cancelled.
 */
export function useCtrlKeyToggle(key: string): boolean {
  const [on, setOn] = useState(false)

  useEffect(() => {
    const target = key.toLowerCase()
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.repeat || isEditableTarget(e.target)) return
      if (e.key.toLowerCase() !== target) return
      e.preventDefault()
      setOn((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [key])

  return on
}
