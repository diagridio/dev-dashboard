// Classify and integrity-check bytes loaded from a binary store.

export type PayloadContent =
  | { kind: 'json'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'binary'; size: number }

export interface LoadedPayload {
  content: PayloadContent
  /** 'unverified': SubtleCrypto is unavailable (non-secure origin), so the hash was not checked. */
  integrity: 'verified' | 'mismatch' | 'unverified'
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function analyzePayload(
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<LoadedPayload> {
  let integrity: LoadedPayload['integrity'] = 'unverified'
  if (globalThis.crypto?.subtle) {
    const actual = await sha256Hex(bytes)
    integrity = actual === expectedSha256.toLowerCase() ? 'verified' : 'mismatch'
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { content: { kind: 'binary', size: bytes.byteLength }, integrity }
  }
  try {
    JSON.parse(text)
    return { content: { kind: 'json', text }, integrity }
  } catch {
    return { content: { kind: 'text', text }, integrity }
  }
}
