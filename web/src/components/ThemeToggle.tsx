import { useState } from 'react'
import { getTheme, setTheme, type Theme } from '../lib/prefs'

export function ThemeToggle() {
  const [theme, setT] = useState<Theme>(getTheme())
  return (
    <button
      data-cy="theme-toggle"
      aria-label="Toggle theme"
      aria-pressed={theme === 'dark'}
      onClick={() => {
        const next: Theme = theme === 'dark' ? 'light' : 'dark'
        setTheme(next)
        setT(next)
      }}
    >
      ◐ {theme === 'dark' ? 'Dark' : 'Light'}
    </button>
  )
}
