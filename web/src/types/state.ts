/** How a key was produced: app code, the workflow engine, or an actor. */
export type StateKind = 'app' | 'workflow' | 'actor'

/** How `preview` / `value` represent the raw bytes. */
export type StateEncoding = 'text' | 'base64'

/** One row in the State table: metadata plus a bounded preview, never the full value. */
export interface StateItem {
  key: string
  appId: string
  logicalKey: string
  kind: StateKind
  preview: string
  encoding: StateEncoding
  size: number
  /** Backend etag — a revision counter, not a timestamp. Absent for some redis entries. */
  etag?: string
  ttlExpiresAt?: string
  contentType?: string
}

export interface StateListResult {
  items: StateItem[]
  /** Non-empty means "keep paging", even when items is short. */
  nextToken?: string
}

/** One record's full value, fetched only when a row is expanded. */
export interface StateRecord {
  key: string
  appId: string
  logicalKey: string
  kind: StateKind
  value: string
  encoding: StateEncoding
  size: number
  truncated: boolean
  etag?: string
  ttlExpiresAt?: string
  contentType?: string
}

export interface StateDeleteResult {
  key: string
  ok: boolean
  error?: string
}

/**
 * One record write. `value` is stored verbatim — Dapr SDKs read values as JSON,
 * but wrapping the text here would make a pasted JSON object unstorable.
 * `overwrite` false makes the server refuse an existing key with a 409.
 */
export interface CreateStatePayload {
  appId: string
  key: string
  value: string
  overwrite: boolean
}

/** A failed write, carrying the HTTP status so 409 can be handled on its own. */
export interface StateWriteError extends Error {
  status?: number
}
