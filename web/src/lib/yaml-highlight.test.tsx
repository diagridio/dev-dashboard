import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { highlightYaml } from './yaml-highlight'

describe('highlightYaml', () => {
  it('renders comment lines with class yc', () => {
    const { container } = render(<pre>{highlightYaml('# comment\n')}</pre>)
    const span = container.querySelector('.yc')
    expect(span).not.toBeNull()
    expect(span?.textContent).toContain('# comment')
  })

  it('renders keys with class yk and data-cy="yaml-key"', () => {
    const { container } = render(<pre>{highlightYaml('name: statestore\n')}</pre>)
    const keySpan = container.querySelector('.yk')
    expect(keySpan).not.toBeNull()
    expect(keySpan?.textContent).toBe('name')
    expect(container.querySelector('[data-cy="yaml-key"]')).not.toBeNull()
  })

  it('renders string values with class ys', () => {
    const { container } = render(<pre>{highlightYaml('name: statestore\n')}</pre>)
    const valSpan = container.querySelector('.ys')
    expect(valSpan).not.toBeNull()
    expect(valSpan?.textContent).toContain('statestore')
  })

  it('renders boolean true with class yd', () => {
    const { container } = render(<pre>{highlightYaml('enabled: true\n')}</pre>)
    const boolSpan = container.querySelector('.yd')
    expect(boolSpan).not.toBeNull()
    expect(boolSpan?.textContent).toBe('true')
    // must NOT render as ys
    expect(container.querySelector('.ys')).toBeNull()
  })

  it('renders boolean false with class yd', () => {
    const { container } = render(<pre>{highlightYaml('debug: false\n')}</pre>)
    const boolSpan = container.querySelector('.yd')
    expect(boolSpan).not.toBeNull()
    expect(boolSpan?.textContent).toBe('false')
  })

  it('preserves full text content including newlines', () => {
    const input = '# comment\nname: statestore\n'
    const { container } = render(<pre>{highlightYaml(input)}</pre>)
    expect(container.textContent).toBe(input)
  })

  it('handles multiple lines', () => {
    const yaml = 'apiVersion: dapr.io/v1alpha1\nkind: Component\n'
    const { container } = render(<pre>{highlightYaml(yaml)}</pre>)
    const keys = container.querySelectorAll('.yk')
    expect(keys).toHaveLength(2)
    expect(keys[0].textContent).toBe('apiVersion')
    expect(keys[1].textContent).toBe('kind')
  })

  it('has no inline style attributes on spans', () => {
    const { container } = render(<pre>{highlightYaml('# comment\nkey: val\n')}</pre>)
    const spans = container.querySelectorAll('span')
    spans.forEach((span) => {
      expect(span).not.toHaveAttribute('style')
    })
  })
})
