import React from 'react'

const KEY_LINE_RE = /^(\s*-?\s*)([\w.-]+)(:)(.*)$/

/**
 * Splits YAML text into highlighted React nodes.
 * - Comment lines (trimmed starts with `#`) → color: var(--text-faint)
 * - `key:` portion → data-cy="yaml-key" + color: var(--link)
 * - value remainder → color: var(--text)
 * - Lines with no match → verbatim text
 * Returns a fragment suitable for use inside a <pre>.
 * Pure/deterministic; no external dependency.
 */
export function highlightYaml(text: string): React.ReactNode {
  const lines = text.split('\n')
  // If the text ends with \n, split produces a trailing empty string — we keep it
  // so that textContent round-trips the original input exactly.
  return (
    <>
      {lines.map((line, i) => {
        const isLast = i === lines.length - 1
        const nl = isLast ? '' : '\n'

        if (line.trimStart().startsWith('#')) {
          return (
            <React.Fragment key={i}>
              <span style={{ color: 'var(--text-faint)' }}>{line}</span>
              {nl}
            </React.Fragment>
          )
        }

        const m = KEY_LINE_RE.exec(line)
        if (m) {
          const [, indent, key, colon, rest] = m
          return (
            <React.Fragment key={i}>
              {indent}
              <span data-cy="yaml-key" style={{ color: 'var(--link)' }}>{key}</span>
              {colon}
              <span style={{ color: 'var(--text)' }}>{rest}</span>
              {nl}
            </React.Fragment>
          )
        }

        // Unmatched line — verbatim
        return (
          <React.Fragment key={i}>
            {line}
            {nl}
          </React.Fragment>
        )
      })}
    </>
  )
}
