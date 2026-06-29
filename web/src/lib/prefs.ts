export type Theme = 'light' | 'dark'

import type { HistoryOrder } from './eventOrder'

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

const HISTORY_ORDER_KEY = 'devdash.workflowHistoryOrder'

export function getHistoryOrder(): HistoryOrder {
  try {
    const v = localStorage.getItem(HISTORY_ORDER_KEY)
    if (v === 'asc' || v === 'desc') return v
  } catch {
    // localStorage may be unavailable (private mode / restricted context)
  }
  return 'asc'
}

export function setHistoryOrder(order: HistoryOrder) {
  try {
    localStorage.setItem(HISTORY_ORDER_KEY, order)
  } catch {
    // ignore persistence failures
  }
}
