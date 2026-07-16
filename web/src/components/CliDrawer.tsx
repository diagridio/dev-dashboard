import { useState } from 'react'
import { getCliContent, resolvePlaceholders } from '../lib/cli'
import { CliCommand } from './CliCommand'
import { useToast } from '../lib/toast'
import { safeGet, safeSet } from '../lib/safeStorage'

const OPEN_KEY = 'devdash.cliDrawerOpen'

interface CliDrawerProps {
  context?: string
  values: Record<string, string | undefined>
}

export function CliDrawer({ context, values }: CliDrawerProps) {
  const content = getCliContent(context)
  const { toast, toastNode } = useToast()
  const [open, setOpen] = useState(() => safeGet(OPEN_KEY) === 'true')

  if (!content) return null

  // Single tool for now (Dapr). The tools map is keyed for a future second
  // tool; a tab bar is intentionally not rendered while only one exists.
  const toolIds = Object.keys(content.tools)
  const tool = content.tools[toolIds[0]]

  function toggle() {
    setOpen((prev) => {
      const next = !prev
      safeSet(OPEN_KEY, String(next))
      return next
    })
  }

  return (
    <div className={`cli-drawer${open ? ' open' : ''}`}>
      <button
        type="button"
        className="cli-tab"
        aria-expanded={open}
        aria-label="CLI commands"
        onClick={toggle}
      >
        CLI
      </button>
      <aside className="cli-panel" aria-label="CLI commands panel">
        <div className="cli-panel-head">
          <h2>CLI</h2>
          <button type="button" className="cli-close" aria-label="Close CLI drawer" onClick={toggle}>
            ✕
          </button>
        </div>
        <div className="cli-commands">
          {tool.commands.map((c) => (
            <CliCommand
              key={c.title}
              title={c.title}
              command={resolvePlaceholders(c.command, values)}
              docs={c.docs}
              onCopied={() => toast.show('Copied')}
            />
          ))}
        </div>
      </aside>
      {toastNode}
    </div>
  )
}
