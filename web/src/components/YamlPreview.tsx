import { highlightYaml } from '../lib/yaml-highlight'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import { downloadText } from '../lib/download'

interface YamlPreviewProps {
  yaml: string
  filename: string
}

export function YamlPreview({ yaml, filename }: YamlPreviewProps) {
  const { toast, toastNode } = useToast()
  return (
    <div>
      <pre className="code">{highlightYaml(yaml)}</pre>
      <div className="stepnav" style={{ marginTop: 10 }}>
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={() => { copyText(yaml); toast.show('Copied') }}>
          Copy
        </button>
        <button type="button" className="btn ghost" onClick={() => downloadText(filename, yaml)}>
          Download
        </button>
      </div>
      {toastNode}
    </div>
  )
}
