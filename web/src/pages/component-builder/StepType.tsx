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

  const categories = Object.keys(byType).sort()
  const category = state.category
  const query = q.trim().toLowerCase()

  return (
    <div>
      <div className="filters" style={{ marginBottom: 12 }}>
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            className="lvchip"
            aria-pressed={category === c}
            onClick={() => dispatch({ type: 'SELECT_CATEGORY', category: c })}
          >
            {c}
          </button>
        ))}
      </div>

      {!category ? (
        <p className="muted">Choose a category to browse components.</p>
      ) : (
        <>
          <div className="search" style={{ marginBottom: 12 }}>
            <input
              type="search"
              aria-label="Search components"
              placeholder={`Search ${category} components…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="complist card">
            {(byType[category] ?? [])
              .filter((s) => !query || s.title.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
              .map((s) => {
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
        </>
      )}
    </div>
  )
}
