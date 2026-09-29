import type { ReactNode } from 'react'

// Markdown-style link in editable copy: [label](https://…). Only http(s) targets
// match, so anything else (javascript:, mailto:, a stray bracket) is left as
// literal text rather than becoming a link.
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g

/**
 * Renders a copy string from `src/content/*.yaml` as React nodes, turning
 * markdown-style links into external text links (`.celllink`, per STYLEGUIDE
 * §7 "Link system"). Everything else is emitted verbatim — this is deliberately
 * not a markdown renderer.
 */
export function renderCopyLinks(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let last = 0

  for (const match of text.matchAll(LINK)) {
    const [raw, label, href] = match
    const start = match.index
    if (start > last) nodes.push(text.slice(last, start))
    nodes.push(
      <a
        key={`${start}-${href}`}
        className="celllink"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {label}
      </a>,
    )
    last = start + raw.length
  }

  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}
