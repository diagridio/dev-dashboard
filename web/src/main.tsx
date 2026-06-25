import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './styles/theme.css'
import { applyPrefs } from './lib/prefs'
import { router } from './router'
import { QueryProvider } from './lib/query'
import { RefreshProvider } from './lib/refresh'

applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <RefreshProvider>
        <RouterProvider router={router} />
      </RefreshProvider>
    </QueryProvider>
  </StrictMode>,
)
