// mulberry32: tiny, fast, good enough for level generation. The state lives in
// GameState so a replay regenerates exactly the same level.

export function nextRandom(s: number): { state: number; value: number } {
  const state = (s + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return { state, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** Folds an outside value in [0, 1) into the generator state. */
export function mix(s: number, v: number): number {
  return (s ^ Math.floor(v * 4294967296)) >>> 0
}

/** Derives a fresh seed for a continue-as-new segment. */
export function seedFrom(s: number): number {
  return Math.floor(nextRandom(s).value * 4294967296) >>> 0
}
