import { useRef } from 'react'
import { Modal } from './Modal'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import { trackAction } from '../lib/telemetry'
import {
  shareContent,
  emailUrl,
  xUrl,
  linkedinUrl,
  blueskyUrl,
  type ShareChannel,
} from '../lib/share'

interface Props {
  open: boolean
  onClose: () => void
}

export function ShareDialog({ open, onClose }: Props) {
  const { toast, toastNode } = useToast()
  const copyRef = useRef<HTMLButtonElement>(null)

  function track(channel: ShareChannel) {
    trackAction('share_click', { channel })
  }

  function handleCopy() {
    copyText(shareContent.fullMessage)
    toast.show('Copied')
    track('copy')
  }

  return (
    <Modal
      open={open}
      title="Share the dashboard"
      onClose={onClose}
      initialFocusRef={copyRef}
      narrow
    >
      <p className="share-intro">Enjoying the dashboard? Send it to a colleague.</p>
      <textarea
        className="share-preview"
        aria-label="Share message preview"
        readOnly
        rows={12}
        value={shareContent.fullMessage}
      />
      <div className="modal-actions share-actions">
        <button ref={copyRef} type="button" className="btn primary" onClick={handleCopy}>
          Copy
        </button>
        <a className="btn ghost" href={emailUrl()} onClick={() => track('email')}>
          Email
        </a>
        <a
          className="btn ghost"
          href={xUrl()}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track('x')}
        >
          X
        </a>
        <a
          className="btn ghost"
          href={linkedinUrl()}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track('linkedin')}
        >
          LinkedIn
        </a>
        <a
          className="btn ghost"
          href={blueskyUrl()}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track('bluesky')}
        >
          BlueSky
        </a>
      </div>
      {toastNode}
    </Modal>
  )
}
