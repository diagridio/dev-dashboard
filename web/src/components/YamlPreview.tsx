import { useEffect, useState } from 'react'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import { downloadText } from '../lib/download'

interface YamlPreviewProps {
  yaml: string
  filename: string
  onEditedChange?: (edited: boolean) => void
}

export function YamlPreview({ yaml, filename, onEditedChange }: YamlPreviewProps) {
  const [buffer, setBuffer] = useState(yaml)
  const [edited, setEdited] = useState(false)
  const { toast, toastNode } = useToast()

  // Notify parent of initial (false) edited state on mount so stale parent state is cleared.
  useEffect(() => {
    onEditedChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-seed when the generated yaml changes AND the user hasn't manually edited.
  useEffect(() => {
    if (!edited) setBuffer(yaml)
  }, [yaml, edited])

  function onInput(value: string) {
    setBuffer(value)
    if (!edited) {
      setEdited(true)
      onEditedChange?.(true)
    }
  }

  function reset() {
    setBuffer(yaml)
    setEdited(false)
    onEditedChange?.(false)
  }

  return (
    <div>
      <textarea
        className="inp code"
        aria-label="Generated YAML"
        rows={16}
        value={buffer}
        onChange={(e) => onInput(e.target.value)}
      />
      <div className="stepnav" style={{ marginTop: 10 }}>
        <button type="button" className="btn ghost" onClick={reset}>Reset to generated</button>
        <div className="spacer" />
        <button
          type="button"
          className="btn ghost"
          onClick={() => { copyText(buffer); toast.show('Copied') }}
        >
          Copy
        </button>
        <button
          type="button"
          className="btn mono"
          onClick={() => downloadText(filename, buffer)}
        >
          Download
        </button>
      </div>
      {toastNode}
    </div>
  )
}
