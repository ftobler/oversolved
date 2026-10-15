// The deterministic id source the drive CLI and journal replay install over the
// yamlMutations default. The default mints from crypto, which is right for the
// app but makes a second run of the same script mint different ids for the
// mutations whose handlers mint internally (add_rect, add_ngon, a fresh
// constraint id); with this source installed those ids are a pure function of
// the call sequence, so the authored document hashes byte-identically across
// runs and a recorded script's journal replays exactly.
//
// The seed is a constant, not a clock or a random value: two `run` invocations
// must agree, and a replay must agree with the recording it reads. The
// generator is mulberry32, small and fully specified; it is not a security
// primitive and mints nothing secret.

import type { IdSource } from '@/utils/yamlMutations/helpers'

export const DRIVE_ID_SEED = 0x5eed_0001

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

/** A seeded id source. A fresh call restarts the sequence, so a caller that
 *  wants two identical runs installs a fresh source before each. */
export function seededIdSource(seed: number = DRIVE_ID_SEED): IdSource {
  const next = mulberry32(seed)
  return (bytes: number): string => {
    const arr = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(next() * 256) & 0xff
    return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }
}
