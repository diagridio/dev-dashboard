import { useEffect, useState } from 'react'
import { isEditableTarget } from '../lib/isEditableTarget'

/**
 * A boolean that flips each time `key` is pressed anywhere outside a form
 * field. Case-insensitive; auto-repeat and Ctrl/Meta/Alt chords are ignored.
 */
export function useKeyToggle(key: string): boolean {
  const [on, setOn] = useState(false)

  useEffect(() => {
    const target = key.toLowerCase()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return
      if (e.key.toLowerCase() === target) setOn((v) => !v)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [key])

  return on
}
