import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ShareDialog } from './ShareDialog'
import { copyText } from '../lib/clipboard'
import { trackAction } from '../lib/telemetry'
import { shareContent, emailUrl, xUrl, linkedinUrl, blueskyUrl } from '../lib/share'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('../lib/telemetry', () => ({ trackAction: vi.fn() }))

const noop = () => {}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ShareDialog', () => {
  it('renders nothing when closed', () => {
    render(<ShareDialog open={false} onClose={noop} />)
    expect(screen.queryByText('Share the dashboard')).toBeNull()
  })

  it('shows the full message preview when open', () => {
    render(<ShareDialog open onClose={noop} />)
    const preview = screen.getByLabelText('Share message preview') as HTMLTextAreaElement
    expect(preview.value).toBe(shareContent.fullMessage)
  })

  it('Copy button copies the full message, shows a toast, and tracks the click', () => {
    render(<ShareDialog open onClose={noop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(copyText).toHaveBeenCalledWith(shareContent.fullMessage)
    expect(trackAction).toHaveBeenCalledWith('share_click', { channel: 'copy' })
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })

  it('renders channel anchors with the correct hrefs', () => {
    render(<ShareDialog open onClose={noop} />)
    expect(screen.getByRole('link', { name: 'Email' })).toHaveAttribute('href', emailUrl())
    expect(screen.getByRole('link', { name: 'X' })).toHaveAttribute('href', xUrl())
    expect(screen.getByRole('link', { name: 'LinkedIn' })).toHaveAttribute('href', linkedinUrl())
    expect(screen.getByRole('link', { name: 'BlueSky' })).toHaveAttribute('href', blueskyUrl())
  })

  it('tracks the channel when a social anchor is clicked', () => {
    render(<ShareDialog open onClose={noop} />)
    fireEvent.click(screen.getByRole('link', { name: 'X' }))
    expect(trackAction).toHaveBeenCalledWith('share_click', { channel: 'x' })
  })
})
