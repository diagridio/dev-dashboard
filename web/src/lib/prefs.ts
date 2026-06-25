export type Theme = 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

const THEME_KEY = 'devdash.theme'
const DENSITY_KEY = 'devdash.density'

export function getTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY)
  if (v === 'light' || v === 'dark') return v
  return 'light' // default light (may consult prefers-color-scheme in a later iteration)
}

export function setTheme(t: Theme) {
  localStorage.setItem(THEME_KEY, t)
  document.documentElement.setAttribute('data-theme', t)
}

export function getDensity(): Density {
  const v = localStorage.getItem(DENSITY_KEY)
  if (v === 'comfortable' || v === 'compact') return v
  return 'compact' // default compact
}

export function setDensity(d: Density) {
  localStorage.setItem(DENSITY_KEY, d)
  document.documentElement.setAttribute('data-density', d)
}

export function applyPrefs() {
  document.documentElement.setAttribute('data-theme', getTheme())
  document.documentElement.setAttribute('data-density', getDensity())
}
