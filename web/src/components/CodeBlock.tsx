import { copyText as copyToClipboard } from '../lib/clipboard'
import { highlightJson } from '../lib/json-highlight'
import { highlightYaml } from '../lib/yaml-highlight'
import { useToast } from '../lib/toast'

interface CodeBlockProps {
  value: string
  kind: 'json' | 'yaml' | 'text'
  label: string // "Copy <label>" / "<label> copied"
  copyValue?: string // defaults to value
  copyText?: string // button text, default '⧉ Copy'
  copyTitle?: string
  wrap?: boolean // pre-wrap instead of horizontal scroll
}

// Bordered code block with its own copy button. The button sits outside the
// scrolling <pre> so it stays visible on long lines and never covers text.
export function CodeBlock({
  value,
  kind,
  label,
  copyValue,
  copyText = '⧉ Copy',
  copyTitle,
  wrap,
}: CodeBlockProps) {
  const { toast, toastNode } = useToast()
  const cls = [kind === 'json' ? 'json' : kind === 'yaml' ? 'code' : '', wrap ? 'wrap' : '']
    .filter(Boolean)
    .join(' ')
  const empty = (copyValue ?? value) === ''
  const body = kind === 'json' ? highlightJson(value) : kind === 'yaml' ? highlightYaml(value) : value
  return (
    <div className="codeblock">
      <pre className={cls || undefined}>{body}</pre>
      <button
        type="button"
        className="copybtn"
        aria-label={`Copy ${label}`}
        title={copyTitle}
        disabled={empty}
        onClick={() => {
          if (empty) return
          copyToClipboard(copyValue ?? value)
          toast.show(`${label} copied`)
        }}
      >
        {copyText}
      </button>
      {toastNode}
    </div>
  )
}
