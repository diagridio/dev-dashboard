import React from 'react'

// Token types matching mock B's pre.json classes:
// .k  → object keys
// .s  → string values
// .n  → numbers
// .p  → punctuation (braces, brackets, colons, commas)
// .b  → booleans and null

type Token =
  | { type: 'key'; text: string }
  | { type: 'string'; text: string }
  | { type: 'number'; text: string }
  | { type: 'punctuation'; text: string }
  | { type: 'literal'; text: string }
  | { type: 'whitespace'; text: string }

const PUNCTUATION = new Set(['{', '}', '[', ']', ':', ','])

/**
 * Tokenises a JSON string (already pretty-printed or compact) into typed tokens.
 * Accepts a raw string — if it's valid JSON it pretty-prints it first; otherwise
 * renders as-is so callers never throw.
 */
function tokenize(raw: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]

    // Whitespace (spaces, newlines, tabs)
    if (/\s/.test(ch)) {
      let ws = ''
      while (i < raw.length && /\s/.test(raw[i])) ws += raw[i++]
      tokens.push({ type: 'whitespace', text: ws })
      continue
    }

    // Punctuation
    if (PUNCTUATION.has(ch)) {
      tokens.push({ type: 'punctuation', text: ch })
      i++
      continue
    }

    // String — key or value (determined by context: after `{` / `,` in an object = key)
    if (ch === '"') {
      let str = '"'
      i++
      while (i < raw.length) {
        const c = raw[i]
        str += c
        i++
        if (c === '\\' && i < raw.length) {
          str += raw[i++] // consume escaped char
        } else if (c === '"') {
          break
        }
      }

      // Determine if this string is a key: skip whitespace after it and check for ':'
      let j = i
      while (j < raw.length && /\s/.test(raw[j])) j++
      const isKey = raw[j] === ':'

      tokens.push({ type: isKey ? 'key' : 'string', text: str })
      continue
    }

    // Number (includes leading `-` and decimals/exponents)
    if (ch === '-' || /\d/.test(ch)) {
      let num = ''
      if (ch === '-') { num += ch; i++ }
      while (i < raw.length && /[\d.eE+-]/.test(raw[i])) num += raw[i++]
      tokens.push({ type: 'number', text: num })
      continue
    }

    // Boolean / null literals
    const literalMatch = raw.slice(i).match(/^(true|false|null)/)
    if (literalMatch) {
      tokens.push({ type: 'literal', text: literalMatch[1] })
      i += literalMatch[1].length
      continue
    }

    // Fallback: emit as whitespace (keeps unknown chars visible)
    tokens.push({ type: 'whitespace', text: ch })
    i++
  }

  return tokens
}

/**
 * Returns highlighted React nodes for a JSON string.
 * If `value` is a raw JSON string the caller can pass it directly.
 * Pretty-printing is attempted; if the value is not valid JSON it is rendered
 * verbatim so the caller never needs to catch.
 *
 * Output is suitable for use inside `<pre className="json">`.
 * Pure/deterministic; no external dependency.
 */
export function highlightJson(value: string): React.ReactNode {
  let displayText: string
  try {
    const parsed = JSON.parse(value)
    displayText = JSON.stringify(parsed, null, 2)
  } catch {
    // Not valid JSON — render verbatim
    displayText = value
  }

  const tokens = tokenize(displayText)

  return (
    <>
      {tokens.map((tok, i) => {
        switch (tok.type) {
          case 'key':
            return <span key={i} className="k">{tok.text}</span>
          case 'string':
            return <span key={i} className="s">{tok.text}</span>
          case 'number':
            return <span key={i} className="n">{tok.text}</span>
          case 'punctuation':
            return <span key={i} className="p">{tok.text}</span>
          case 'literal':
            return <span key={i} className="b">{tok.text}</span>
          default:
            return <React.Fragment key={i}>{tok.text}</React.Fragment>
        }
      })}
    </>
  )
}
