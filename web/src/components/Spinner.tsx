import { useEffect, useState } from 'react'

const FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const FRAME_MS = 80

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Inline braille-dots spinner for in-progress text. Decorative only: pair it
 * with a text label (e.g. inside role="status"). Under prefers-reduced-motion
 * it renders nothing, so the label alone carries the state.
 */
export function Spinner() {
  const [reduced] = useState(prefersReducedMotion)
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (reduced) return
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS)
    return () => clearInterval(t)
  }, [reduced])

  if (reduced) return null
  return (
    <span data-cy="spinner" aria-hidden="true" className="mono">
      {FRAMES[frame]}
    </span>
  )
}
