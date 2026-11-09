import { render, screen } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { ResourceSources } from './ResourceSources'

describe('ResourceSources', () => {
  afterEach(() => {
    delete window.__DASH_CAPABILITIES__
  })

  it('names the host sources outside container posture', () => {
    render(<p>from <ResourceSources host={<span>~/.dapr/components</span>} /></p>)
    expect(screen.getByText('~/.dapr/components')).toBeInTheDocument()
    expect(screen.queryByText(/DEVDASHBOARD_RESOURCES_PATH/)).not.toBeInTheDocument()
  })

  it('names the mounted folders in container posture', () => {
    window.__DASH_CAPABILITIES__ = {
      lifecycle: false, controlPlane: false, logs: false, workflows: true,
      mode: 'compose', containerPosture: true,
    }
    render(<p>from <ResourceSources host={<span>~/.dapr/components</span>} /></p>)
    expect(screen.getByText('DEVDASHBOARD_RESOURCES_PATH')).toBeInTheDocument()
    expect(screen.queryByText('~/.dapr/components')).not.toBeInTheDocument()
  })
})
