export type Theme = 'light' | 'dark'

const THEME_KEY = 'devdash.theme'

export function getTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY)
  if (v === 'light' || v === 'dark') return v
  return 'light' // default light
}

export function setTheme(t: Theme) {
  localStorage.setItem(THEME_KEY, t)
}

export function applyPrefs() {
  // No-op for data-theme: App.tsx manages the attribute on the .app div via React state.
  // Called in main.tsx; kept for backwards compatibility.
}
