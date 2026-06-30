import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { MetadataFieldInput } from './MetadataFieldInput'

describe('MetadataFieldInput', () => {
  it('renders a masked input for sensitive fields', () => {
    render(<MetadataFieldInput field={{ name: 'redisPassword', sensitive: true, type: 'string' }} value="s" onChange={() => {}} />)
    expect(screen.getByLabelText('redisPassword')).toHaveAttribute('type', 'password')
  })

  it('renders a select for allowedValues and reports changes', () => {
    const onChange = vi.fn()
    render(<MetadataFieldInput field={{ name: 'failover', allowedValues: ['sentinel', 'cluster'] }} value="" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('failover'), { target: { value: 'cluster' } })
    expect(onChange).toHaveBeenCalledWith('cluster')
  })

  it('renders a checkbox for bool fields mapping to true/empty', () => {
    const onChange = vi.fn()
    render(<MetadataFieldInput field={{ name: 'enableTLS', type: 'bool' }} value="" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('enableTLS'))
    expect(onChange).toHaveBeenCalledWith('true')
  })

  it('renders a number input for number fields', () => {
    render(<MetadataFieldInput field={{ name: 'maxRetries', type: 'number' }} value="3" onChange={() => {}} />)
    expect(screen.getByLabelText('maxRetries')).toHaveAttribute('type', 'number')
  })
})
