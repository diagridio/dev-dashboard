import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { highlightJson } from './json-highlight'

describe('highlightJson', () => {
  it('renders object keys with class k', () => {
    const { container } = render(<pre className="json">{highlightJson('{"name":"statestore"}')}</pre>)
    const keySpan = container.querySelector('.k')
    expect(keySpan).not.toBeNull()
    expect(keySpan?.textContent).toBe('"name"')
  })

  it('renders string values with class s', () => {
    const { container } = render(<pre className="json">{highlightJson('{"name":"statestore"}')}</pre>)
    const strSpan = container.querySelector('.s')
    expect(strSpan).not.toBeNull()
    expect(strSpan?.textContent).toBe('"statestore"')
  })

  it('renders integer numbers with class n', () => {
    const { container } = render(<pre className="json">{highlightJson('{"count":42}')}</pre>)
    const numSpan = container.querySelector('.n')
    expect(numSpan).not.toBeNull()
    expect(numSpan?.textContent).toBe('42')
  })

  it('renders decimal numbers with class n', () => {
    const { container } = render(<pre className="json">{highlightJson('{"price":59.98}')}</pre>)
    const numSpan = container.querySelector('.n')
    expect(numSpan).not.toBeNull()
    expect(numSpan?.textContent).toBe('59.98')
  })

  it('renders punctuation (braces, colons, commas) with class p', () => {
    const { container } = render(<pre className="json">{highlightJson('{"a":1}')}</pre>)
    const pSpans = container.querySelectorAll('.p')
    const texts = Array.from(pSpans).map((s) => s.textContent)
    expect(texts).toContain('{')
    expect(texts).toContain('}')
    expect(texts).toContain(':')
  })

  it('renders brackets with class p', () => {
    const { container } = render(<pre className="json">{highlightJson('{"items":[1,2]}')}</pre>)
    const pSpans = container.querySelectorAll('.p')
    const texts = Array.from(pSpans).map((s) => s.textContent)
    expect(texts).toContain('[')
    expect(texts).toContain(']')
  })

  it('renders true boolean with class b', () => {
    const { container } = render(<pre className="json">{highlightJson('{"flag":true}')}</pre>)
    const bSpan = container.querySelector('.b')
    expect(bSpan).not.toBeNull()
    expect(bSpan?.textContent).toBe('true')
  })

  it('renders false boolean with class b', () => {
    const { container } = render(<pre className="json">{highlightJson('{"debug":false}')}</pre>)
    const bSpan = container.querySelector('.b')
    expect(bSpan).not.toBeNull()
    expect(bSpan?.textContent).toBe('false')
  })

  it('renders null with class b', () => {
    const { container } = render(<pre className="json">{highlightJson('{"end":null}')}</pre>)
    const bSpan = container.querySelector('.b')
    expect(bSpan).not.toBeNull()
    expect(bSpan?.textContent).toBe('null')
  })

  it('renders complex nested JSON with correct classes', () => {
    const json = JSON.stringify({
      orderId: 'ORD-48213',
      items: [{ qty: 2 }],
      total: 59.98,
      active: true,
      end: null,
    })
    const { container } = render(<pre className="json">{highlightJson(json)}</pre>)
    expect(container.querySelector('.k')).not.toBeNull()
    expect(container.querySelector('.s')).not.toBeNull()
    expect(container.querySelector('.n')).not.toBeNull()
    expect(container.querySelector('.p')).not.toBeNull()
    expect(container.querySelector('.b')).not.toBeNull()
  })

  it('pretty-prints compact JSON', () => {
    const { container } = render(<pre className="json">{highlightJson('{"a":1}')}</pre>)
    // pretty-printed version has newlines
    expect(container.textContent).toContain('\n')
  })

  it('renders invalid JSON verbatim without throwing', () => {
    const bad = 'not json at all'
    const { container } = render(<pre className="json">{highlightJson(bad)}</pre>)
    expect(container.textContent).toContain('not json at all')
  })

  it('has no inline style attributes on spans', () => {
    const { container } = render(<pre className="json">{highlightJson('{"key":"val"}')}</pre>)
    const spans = container.querySelectorAll('span')
    spans.forEach((span) => {
      expect(span).not.toHaveAttribute('style')
    })
  })
})
