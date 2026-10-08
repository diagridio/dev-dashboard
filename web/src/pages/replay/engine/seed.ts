/** FNV-1a over `replay:<date>`: everyone gets the same levels on the same UTC day. */
export function seedForDate(date: string): number {
  const text = `replay:${date}`
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
