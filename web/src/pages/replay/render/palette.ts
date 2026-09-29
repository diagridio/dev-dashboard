// Canvas colours come from the dashboard's theme tokens, so the game follows
// light/dark mode. Never put colour literals here (styleguide rule).

export type Slot = 'bg' | 'ground' | 'backdrop' | 'player' | 'hat' | 'hatOutline' | 'obstacle' | 'coin' | 'orb' | 'crate' | 'text' | 'muted' | 'glitch' | 'fail'
export type Palette = Record<Slot, string>

export const SLOT_TOKENS: Record<Slot, string> = {
  bg: '--surface',
  ground: '--line',
  backdrop: '--surface-2',
  player: '--accent-bright',
  hat: '--dapr-hat',
  hatOutline: '--dapr-hat-outline',
  obstacle: '--fail-fg',
  coin: '--gold',
  orb: '--purple',
  crate: '--run-fg',
  text: '--text',
  muted: '--muted',
  glitch: '--dapr',
  fail: '--fail-fg',
}

const FALLBACK = 'gray'

/** Reads the palette from an element inside `.app` (tokens are scoped there). */
export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el)
  const entries = Object.entries(SLOT_TOKENS).map(([slot, token]) => [slot, cs.getPropertyValue(token).trim() || FALLBACK])
  return Object.fromEntries(entries) as Palette
}

/** Calls back when the theme toggles (App mirrors data-theme onto <html>). */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(() => onChange())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}
