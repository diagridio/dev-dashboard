import type { Command } from './types'

/** Maps a key event to a game command. Auto-repeat keydowns are dropped. */
export function keyToCommand(e: Pick<KeyboardEvent, 'key' | 'repeat'>, down: boolean): Command | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (!down) return key === 'ArrowDown' || key === 's' ? 'slideEnd' : null
  if (e.repeat) return null
  switch (key) {
    case ' ':
    case 'ArrowUp':
    case 'w':
      return 'jump'
    case 'ArrowDown':
    case 's':
      return 'slideStart'
    case 'Enter':
      return 'confirm'
    case 'Escape':
      return 'cancel'
    case 'p':
      return 'pause'
    default:
      return null
  }
}
