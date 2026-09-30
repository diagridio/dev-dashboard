import { isTape, type Tape } from './tape'

export const RUN_CODE_PREFIX = 'RPL1.'
/** Longest code we try to decode. */
export const MAX_RUN_CODE = 256 * 1024
/** Longest decompressed tape we accept (guards against a deflate bomb). */
export const MAX_TAPE_JSON = 4 * 1024 * 1024

/** Runs bytes through a (de)compression stream, giving up past `limit` output bytes. */
async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter()
  // Not awaited: the readable side must drain concurrently. Errors surface on read().
  writer.write(bytes).catch(() => {})
  writer.close().catch(() => {})
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      throw new Error('too large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
}

/** A tape as a shareable run code: RPL1. + base64url(deflate-raw(JSON)). */
export async function encodeRun(tape: Tape): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(tape))
  return RUN_CODE_PREFIX + toBase64Url(await pipe(json, new CompressionStream('deflate-raw'), Number.POSITIVE_INFINITY))
}

/** The run code for a tape, or null when it is longer than decodeRun accepts. */
export async function shareableRunCode(tape: Tape): Promise<string | null> {
  const code = await encodeRun(tape)
  return code.length > MAX_RUN_CODE ? null : code
}

/** The tape inside a run code, or null for anything that isn't a valid code. Whitespace is ignored. */
export async function decodeRun(code: string): Promise<Tape | null> {
  const clean = code.replace(/\s+/g, '')
  if (!clean.startsWith(RUN_CODE_PREFIX) || clean.length > MAX_RUN_CODE) return null
  try {
    const bytes = fromBase64Url(clean.slice(RUN_CODE_PREFIX.length))
    const json = new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_TAPE_JSON))
    const data: unknown = JSON.parse(json)
    return isTape(data) ? data : null
  } catch {
    return null
  }
}

/** Copies a run code; 'manual' means the page should show it for the player to copy. */
export async function copyRunCode(code: string, clipboard: Pick<Clipboard, 'writeText'> | undefined): Promise<'copied' | 'manual'> {
  if (!clipboard) return 'manual'
  try {
    await clipboard.writeText(code)
    return 'copied'
  } catch {
    return 'manual'
  }
}
