import React from 'react'

const KEY_LINE_RE = /^(\s*-?\s*)([\w.-]+)(:)(.*)$/
const BOOL_DAPR_RE = /^(\s*)(true|false)(\s*)$/

/**
 * Splits YAML text into highlighted React nodes using mock CSS classes.
 * - Comment lines (trimmed starts with `#`) → <span className="yc">
 * - `key:` portion → <span className="yk" data-cy="yaml-key">
 * - string/scalar values → <span className="ys">
 * - boolean/Dapr literals (true/false alone on a line) → <span className="yd">
 * - Lines with no match → verbatim text
 * Returns a fragment suitable for use inside a <pre className="code">.
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

        // Comment lines
        if (line.trimStart().startsWith('#')) {
          return (
            <React.Fragment key={i}>
              <span className="yc">{line}</span>
              {nl}
            </React.Fragment>
          )
        }

        // Boolean/Dapr literals on their own (value-only lines like `  true`)
        const boolM = BOOL_DAPR_RE.exec(line)
        if (boolM) {
          const [, indent, literal, trail] = boolM
          return (
            <React.Fragment key={i}>
              {indent}
              <span className="yd">{literal}</span>
              {trail}
              {nl}
            </React.Fragment>
          )
        }

        // key: value lines
        const m = KEY_LINE_RE.exec(line)
        if (m) {
          const [, indent, key, colon, rest] = m
          // Check if the value part contains a boolean/Dapr literal
          const trimmedRest = rest.trimStart()
          const leadingSpace = rest.slice(0, rest.length - trimmedRest.length)
          const isBoolLiteral = trimmedRest === 'true' || trimmedRest === 'false'
          return (
            <React.Fragment key={i}>
              {indent}
              <span data-cy="yaml-key" className="yk">{key}</span>
              {colon}
              {rest.length > 0 && (
                isBoolLiteral
                  ? <>{leadingSpace}<span className="yd">{trimmedRest}</span></>
                  : <span className="ys">{rest}</span>
              )}
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
