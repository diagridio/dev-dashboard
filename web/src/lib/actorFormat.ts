/** Reentrancy display: `off`, `on`, or `on (depth N)`. */
export function reentrancyLabel(r: { enabled: boolean; maxStackDepth?: number }): string {
  if (!r.enabled) return 'off'
  return r.maxStackDepth ? `on (depth ${r.maxStackDepth})` : 'on'
}
