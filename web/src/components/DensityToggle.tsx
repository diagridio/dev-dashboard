import { useState } from 'react'
import { getDensity, setDensity, type Density } from '../lib/prefs'

export function DensityToggle() {
  const [density, setD] = useState<Density>(getDensity())
  return (
    <button
      data-cy="density-toggle"
      aria-label="Toggle density"
      aria-pressed={density === 'compact'}
      onClick={() => {
        const next: Density = density === 'compact' ? 'comfortable' : 'compact'
        setDensity(next)
        setD(next)
      }}
    >
      {density === 'compact' ? 'Switch to comfortable' : 'Switch to compact'}
    </button>
  )
}
