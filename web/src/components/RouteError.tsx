import { useEffect } from 'react'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { trackError } from '../lib/telemetry'

/**
 * Route-level error boundary. Rendered by react-router (via `errorElement`)
 * when a route element throws during render, so users get a recoverable page
 * instead of the raw "Unexpected Application Error" screen.
 */
export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)

  useEffect(() => {
    trackError(error)
  }, [error])

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>Something went wrong</h1>
          <div className="sub">The page hit an unexpected error while rendering</div>
        </div>
      </div>
      <div className="panel">
        <div className="ph">Error</div>
        <p className="err">{message}</p>
        <p className="muted">Reload the page, or go back to the applications list.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <Link className="btn ghost" to="/">
            Back to Applications
          </Link>
        </div>
      </div>
    </div>
  )
}
