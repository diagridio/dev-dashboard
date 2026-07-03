export type Theme = 'light' | 'dark'

import type { HistoryOrder } from './eventOrder'
import { safeGet, safeSet } from './safeStorage'

const THEME_KEY = 'devdash.theme'

export function getTheme(): Theme {
  const v = safeGet(THEME_KEY)
  if (v === 'light' || v === 'dark') return v
  return 'light' // default light
}

export function setTheme(t: Theme) {
  safeSet(THEME_KEY, t)
}

export function applyPrefs() {
  // No-op for data-theme: App.tsx manages the attribute on the .app div via React state.
  // Called in main.tsx; kept for backwards compatibility.
}

const HISTORY_ORDER_KEY = 'devdash.workflowHistoryOrder'

export function getHistoryOrder(): HistoryOrder {
  const v = safeGet(HISTORY_ORDER_KEY)
  if (v === 'asc' || v === 'desc') return v
  return 'asc'
}

export function setHistoryOrder(order: HistoryOrder) {
  safeSet(HISTORY_ORDER_KEY, order)
}
