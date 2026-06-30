import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { setupServer } from 'msw/node'

// Node 24+ exposes a native global `localStorage` (Web Storage API). Under jsdom it
// shadows jsdom's own Storage, and without a valid `--localstorage-file` it is a
// broken object lacking a usable `clear()`. Install a deterministic in-memory Storage
// so the suite behaves identically across OSes and Node versions.
function installMemoryStorage() {
  const make = (): Storage => {
    const store = new Map<string, string>()
    return {
      get length() {
        return store.size
      },
      clear: () => store.clear(),
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => [...store.keys()][i] ?? null,
    }
  }
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const value = make()
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    if (typeof window !== 'undefined') {
      Object.defineProperty(window, name, { value, configurable: true, writable: true })
    }
  }
}

installMemoryStorage()

// Shared MSW server; handlers are added per-test with server.use(...).
export const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
