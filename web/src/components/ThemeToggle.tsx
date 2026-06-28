import { setTheme, type Theme } from '../lib/prefs'

interface ThemeToggleProps {
  theme: Theme
  onThemeChange: (t: Theme) => void
}

export function ThemeToggle({ theme, onThemeChange }: ThemeToggleProps) {
  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    onThemeChange(next)
  }

  return (
    <button
      className="tbtn"
      data-cy="theme-toggle"
      aria-label="Toggle theme"
      aria-pressed={theme === 'dark'}
      onClick={toggle}
    >
      ◐ Theme
    </button>
  )
}
