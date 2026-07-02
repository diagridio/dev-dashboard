import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../lib/useDocumentTitle'

export function Resiliency() {
  useDocumentTitle('Resiliency')
  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>Resiliency</h1>
          <div className="sub">Dapr resiliency policies</div>
        </div>
        <Link className="btn ghost" to="/resiliency/new">+ New resiliency policy</Link>
      </div>
      <div className="md">
        <div className="card complist" />
        <div className="card">
          <p className="hint" style={{ padding: '14px' }}>
            No resiliency policies. Use &ldquo;New resiliency policy&rdquo; to build one.
          </p>
        </div>
      </div>
    </div>
  )
}
