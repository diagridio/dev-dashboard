import { copyText } from '../lib/clipboard'

interface CliCommandProps {
  title: string
  command: string
  docs?: string
  onCopied?: () => void
}

export function CliCommand({ title, command, docs, onCopied }: CliCommandProps) {
  function handleCopy() {
    copyText(command)
    onCopied?.()
  }

  return (
    <div className="cli-command">
      <div className="cli-command-head">
        <span className="cli-command-title">{title}</span>
        {docs && (
          <a
            className="cli-command-docs"
            href={docs}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${title} — Dapr CLI docs`}
          >
            ↗
          </a>
        )}
      </div>
      <div className="cli-command-row">
        <code className="cli-command-code">{command}</code>
        <button
          type="button"
          className="btn ghost cli-copy"
          aria-label={`Copy command: ${command}`}
          onClick={handleCopy}
        />
      </div>
    </div>
  )
}
