import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CliCommand } from './CliCommand'
import { copyText } from '../lib/clipboard'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CliCommand', () => {
  it('renders the title and command text', () => {
    render(<CliCommand title="Stop this app" command="dapr stop --app-id order" />)
    expect(screen.getByText('Stop this app')).toBeInTheDocument()
    expect(screen.getByText('dapr stop --app-id order')).toBeInTheDocument()
  })

  it('copies the exact command and calls onCopied when Copy is clicked', () => {
    const onCopied = vi.fn()
    render(
      <CliCommand title="Stop this app" command="dapr stop --app-id order" onCopied={onCopied} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(copyText).toHaveBeenCalledWith('dapr stop --app-id order')
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('renders a docs link only when docs is set', () => {
    const { rerender } = render(<CliCommand title="A" command="dapr list" />)
    expect(screen.queryByRole('link')).toBeNull()
    rerender(<CliCommand title="A" command="dapr list" docs="https://docs.dapr.io/x/" />)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://docs.dapr.io/x/')
  })
})
