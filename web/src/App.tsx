import { Outlet } from 'react-router-dom'
import { SmallScreenGuard } from './components/SmallScreenGuard'
import { TopNav } from './components/TopNav'

export default function App() {
  return (
    <SmallScreenGuard>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100dvh',
          overflow: 'hidden',
          background: 'var(--bg)',
          color: 'var(--text)',
        }}
      >
        <TopNav />
        <div style={{ flex: 1, overflow: 'auto' }}>
          <Outlet />
        </div>
      </div>
    </SmallScreenGuard>
  )
}
