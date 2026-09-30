import { useEffect, useRef } from 'react'
import { isEditableTarget } from '../lib/isEditableTarget'

/** Keys that never break the sequence on their own (Shift+B still counts as B). */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

export const KONAMI: readonly string[] = [
  'arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a',
]

const GLYPH: Record<string, string> = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→' }

/** A key sequence as shown to people: arrows as glyphs, letters upper-case. */
export function konamiLabel(keys: readonly string[] = KONAMI): string {
  return keys.map((k) => GLYPH[k] ?? k.toUpperCase()).join(' ')
}

/** Calls onMatch when the Konami code is typed anywhere outside a form field. */
export function useKonami(onMatch: () => void): void {
  const latest = useRef(onMatch)
  useEffect(() => {
    latest.current = onMatch
  }, [onMatch])

  useEffect(() => {
    let recent: string[] = []
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || MODIFIERS.has(e.key) || isEditableTarget(e.target)) return
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
