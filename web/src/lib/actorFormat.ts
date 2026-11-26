/** Reentrancy display: `off`, `on`, or `on (depth N)`. */
export function reentrancyLabel(r: { enabled: boolean; maxStackDepth?: number }): string {
  if (!r.enabled) return 'off'
  return r.maxStackDepth ? `on (depth ${r.maxStackDepth})` : 'on'
}

/** The user-facing part of an actor state key: `type||id||key` shows as `key`. */
export function actorStateKey(logicalKey: string, type: string, id: string): string {
  const prefix = `${type}||${id}||`
  return logicalKey.startsWith(prefix) ? logicalKey.slice(prefix.length) : logicalKey
}

/** Dapr-internal actor types (workflow, scheduler) are not user-invocable or editable. */
export function isInternalActorType(type: string): boolean {
  return type.startsWith('dapr.internal.')
}
