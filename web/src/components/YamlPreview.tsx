import { CodeBlock } from './CodeBlock'
import { downloadText } from '../lib/download'

interface YamlPreviewProps {
  yaml: string
  filename: string
}

export function YamlPreview({ yaml, filename }: YamlPreviewProps) {
  return (
    <div>
      <CodeBlock value={yaml} kind="yaml" label="YAML" />
      <div className="stepnav" style={{ marginTop: 10 }}>
        <div className="spacer" />
        <button type="button" className="btn ghost" onClick={() => downloadText(filename, yaml)}>
          Download
        </button>
      </div>
    </div>
  )
}
