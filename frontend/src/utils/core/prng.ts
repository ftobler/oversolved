/**
 * The one deterministic PRNG behind every seeded fuzz and the drive id source.
 *
 * mulberry32: 32 bits of state, one multiply-xor round per draw, and no
 * dependency, so one seed means one sequence on every machine and Node
 * version. Three hand copies of this function used to exist (the session
 * fuzz harness, the document loader fuzz and `drive/seededIds.ts`); the pinned
 * seeds of every fuzz depend on this exact arithmetic, so the stream is frozen
 * by `__tests__/prng.test.ts`.
 */
export function makePrng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
