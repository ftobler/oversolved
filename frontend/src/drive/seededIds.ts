// The deterministic id source the journal installs over the yamlMutations
// default. The default mints from crypto, which is right for the app but makes
// a recorded journal unreproducible for the mutations whose handlers mint
// internally (add_rect, add_ngon, a fresh constraint id). A journal generation
// installs this source under a recorded seed, so those ids become a pure
// function of (seed, source position), a repro carries the seed, and replay
// seeks each entry's recorded position before applying it.
//
// The generator is mulberry32, small and fully specified; it is not a security
// primitive and mints nothing secret. Cross-session uniqueness comes from the
// seed: the browser draws it from crypto per generation, the drive CLI derives
// it from the starting document (driveSeedFor), so two runs of one script
// agree while a chained call on the result draws a different sequence.

import type { IdSource } from '@/utils/yamlMutations/helpers'

export const DRIVE_ID_SEED = 0x5eed_0001

/** An id source whose sequence is addressable: `index()` is the number of
 *  generator steps consumed and `seek(n)` moves the sequence to a recorded
 *  position, which is what lets replay resume after ids the recording minted
 *  outside the session (UI feature ids) that replay never mints. */
export interface SeededIdSource extends IdSource {
  readonly seed: number
  index(): number
  seek(index: number): void
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A fresh seed for a journal generation, drawn once from crypto so different
 *  sessions (and generations) do not share an id sequence. */
export function cryptoGenerationSeed(): number {
  const arr = new Uint32Array(1)
  crypto.getRandomValues(arr)
  return arr[0]
}

/** The seed one drive operation mints under, derived from the starting
 *  document's content hash. A chained call (docHash from the previous reply)
 *  starts from a different document and therefore draws a different sequence,
 *  while the same document with the same script derives the same seed and stays
 *  byte-identical. FNV-1a over the hex hash mixes it into the pinned drive seed;
 *  the result only has to be stable and spread, not cryptographic. */
export function driveSeedFor(docHash: string): number {
  let mixed = 0x811c9dc5
  for (let i = 0; i < docHash.length; i++) {
    mixed ^= docHash.charCodeAt(i)
    mixed = Math.imul(mixed, 0x01000193) >>> 0
  }
  return (DRIVE_ID_SEED ^ mixed) >>> 0
}

/** A seeded id source. A fresh call restarts the sequence at index 0. */
export function seededIdSource(seed: number = DRIVE_ID_SEED): SeededIdSource {
  let next = mulberry32(seed)
  let steps = 0
  const mint = (bytes: number): string => {
    const arr = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) {
      arr[i] = Math.floor(next() * 256) & 0xff
      steps++
    }
    return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }
  return Object.assign(mint, {
    seed,
    index: () => steps,
    seek: (target: number) => {
      const to = Math.max(0, Math.floor(target))
      // A backward seek can only come from a replayed suffix whose recording
      // restarted; replay the generator from the seed to that position.
      if (to < steps) {
        next = mulberry32(seed)
        steps = 0
      }
      while (steps < to) {
        next()
        steps++
      }
    },
  })
}
