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
// seed: the browser draws it from crypto per generation, while a drive script
// derives one seed per step (stepSeedFor) so the ids depend on the document
// before the step and the step itself, never on how a caller chunked the
// script across `run` calls.

import { stableJson } from '@/kernel/builderHash'
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

// FNV-1a over a string, mixed into the seed it is given. The result only has to
// be stable and spread, not cryptographic.
function mixText(text: string, seed: number): number {
  let mixed = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    mixed ^= text.charCodeAt(i)
    mixed = Math.imul(mixed, 0x01000193) >>> 0
  }
  return mixed
}

/** The seed one drive operation mints under, derived from the starting
 *  document's content hash. It seeds the journal generation (and every entry a
 *  legacy recording carries no step seed for); a script step mints under its
 *  own step seed below so chunking the same script draws the same ids. */
export function driveSeedFor(docHash: string): number {
  return (DRIVE_ID_SEED ^ mixText(docHash, 0x811c9dc5)) >>> 0
}

// The step's own content, without the runner's control flag: whether a failure
// continues the script changes what happens after the step, not what it mints.
function stepContent(step: unknown): unknown {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) return step
  const content = { ...(step as Record<string, unknown>) }
  delete content.continueOnError
  return content
}

/** The seed one script step mints under: the authored document immediately
 *  before the step (its content hash) mixed with the step's own content. One
 *  call, a 3+3 split and a 1x6 split all present the same document before the
 *  same step, so the step mints the same ids and the chunks chain to the same
 *  document hash. */
export function stepSeedFor(docHash: string, step: unknown): number {
  return mixText(stableJson(stepContent(step)), driveSeedFor(docHash))
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
