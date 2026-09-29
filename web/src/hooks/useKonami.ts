import { useEffect, useRef } from 'react'
import { isEditableTarget } from '../lib/isEditableTarget'

export const KONAMI: readonly string[] = [
  'arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a',
]

/** Calls onMatch when the Konami code is typed anywhere outside a form field. */
export function useKonami(onMatch: () => void): void {
  const latest = useRef(onMatch)
  useEffect(() => {
    latest.current = onMatch
  }, [onMatch])

  useEffect(() => {
    let recent: string[] = []
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      recent = [...recent, e.key.toLowerCase()].slice(-KONAMI.length)
      if (recent.length === KONAMI.length && recent.every((k, i) => k === KONAMI[i])) {
        recent = []
        latest.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
