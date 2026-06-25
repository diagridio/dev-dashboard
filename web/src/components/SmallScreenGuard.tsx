import { useEffect, useState, type ReactNode } from 'react'

const MIN_WIDTH = 1024

export function SmallScreenGuard({ children }: { children: ReactNode }) {
  const [wide, setWide] = useState(
    () => window.matchMedia(`(min-width: ${MIN_WIDTH}px)`).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${MIN_WIDTH}px)`)
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  if (wide) return <>{children}</>

  return (
    <div
      data-cy="small-screen-overlay"
      role="alertdialog"
      aria-label="Screen too small"
      style={{
        position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
        background: 'var(--bg)', color: 'var(--text)', textAlign: 'center', padding: 24,
      }}
    >
      <div style={{ maxWidth: 360 }}>
        <h2>The dashboard is designed for a wider screen</h2>
        <p style={{ color: 'var(--text-muted)' }}>Please widen the window to continue.</p>
      </div>
    </div>
  )
}
