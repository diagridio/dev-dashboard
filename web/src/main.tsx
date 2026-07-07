import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './styles/theme.css'
import { applyPrefs } from './lib/prefs'
import { router } from './router'
import { QueryProvider } from './lib/query'
import { RefreshProvider } from './lib/refresh'
import { ConnectionProvider } from './lib/connection'
import { initTelemetry } from './lib/telemetry'

void initTelemetry()
applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <RefreshProvider>
        <ConnectionProvider>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </ConnectionProvider>
      </RefreshProvider>
    </QueryProvider>
  </StrictMode>,
)
