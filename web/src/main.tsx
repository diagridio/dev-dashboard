import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import { applyPrefs } from './lib/prefs'

applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div>Dev Dashboard</div>
  </StrictMode>,
)
