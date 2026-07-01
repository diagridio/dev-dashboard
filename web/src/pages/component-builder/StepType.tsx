import { useState } from 'react'
import { useComponentSchemas } from '../../hooks/useComponentSchemas'
import type { Action, ComponentBuilderState } from './reducer'

interface Props {
  state: ComponentBuilderState
  dispatch: (a: Action) => void
}

export function StepType({ state, dispatch }: Props) {
  const { byType, isLoading } = useComponentSchemas()
  const [q, setQ] = useState('')

  if (isLoading) return <p className="muted">Loading catalog…</p>

  const query = q.trim().toLowerCase()
  const types = Object.keys(byType).sort()

  return (
    <div>
      <div className="search" style={{ marginBottom: 12 }}>
        <input
          type="search"
          aria-label="Search components"
          placeholder="Search components…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="complist card">
        {types.map((type) => {
          const matches = byType[type].filter(
            (s) => !query || s.title.toLowerCase().includes(query) || s.name.toLowerCase().includes(query),
          )
          if (matches.length === 0) return null
          return (
            <div key={type} className="sbsection">
              <div className="sbtitle">{type}</div>
              {matches.map((s) => {
                const selected = state.schema?.type === s.type && state.schema?.name === s.name
                return (
                  <div
                    key={`${s.type}.${s.name}`}
                    className={`ci${selected ? ' sel' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => dispatch({ type: 'SELECT_SCHEMA', schema: s, version: s.version })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') dispatch({ type: 'SELECT_SCHEMA', schema: s, version: s.version })
                    }}
                  >
                    <span className="cn">{s.title}</span>
                    <span className="ct">{`${s.type}.${s.name}`} · {s.version} · {s.status}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
