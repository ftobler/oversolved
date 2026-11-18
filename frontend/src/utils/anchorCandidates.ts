// Stage 7's pick contract: an ID-buffer hit resolves to a SET of mate
// references, not to one.
//
// The part editor can assume one hit means one selection because its entities
// are disjoint on screen. An assembly cannot: a single pixel at a box corner
// covers three faces, three edges and a vertex, each carrying its own anchor,
// and any of the seven may be the mate reference the user meant. So the pick
// returns them all, ordered as the resolver ranked them (highest-priority layer
// first, nearest pixel first), and the user cycles or narrows the scope.
//
// Nothing here knows about three.js, the ID buffer, or the store. It maps
// opaque entity keys to `MateRef`s through a lookup the bundle authored.

import type { MateRef } from '@/types/cad'

/** The picked-entity classes an assembly bundle indexes anchors by. */
export type AssemblyEntityKind = 'face' | 'edge' | 'vertex'

/**
 * Entity pick id for one B-rep entity of one part instance. `bodyIndex` and
 * `index` are positions in the bundle's arrays, which is what the ID layers
 * register and what `EntityAnchorIndex` is keyed by. The part handle leads so
 * two instances of the same part never share a pick id.
 */
export function assemblyEntityKey(
  handle: string, partIndex: number, kind: AssemblyEntityKind, index: number,
): string {
  return `${handle}|${partIndex}|${kind}|${index}`
}

/** Entity pick id for an assembly built-in (its origin, its 3 planes). */
export function assemblyBuiltinEntityKey(builtinId: string): string {
  return `__builtin|${builtinId}`
}

/**
 * Entity pick id -> the mate references it offers, one-to-many by construction.
 * An entity with no matable anchor (a freeform face, an ellipse edge) is absent
 * or maps to an empty list; that is not an error, it simply cannot be mated.
 */
export type EntityMateRefs = Record<string, MateRef[]>

function refKey(ref: MateRef): string {
  return `${ref.part}|${ref.anchor}`
}

/**
 * The candidate set under the cursor, in the order the chip should cycle it.
 *
 * `hits` must arrive resolver-ordered; this preserves that order and dedupes,
 * so the first candidate is the one a singleton pick would have returned.
 * `scopeEntityKey` is the Ctrl+hover entity-scope filter: it restricts the set
 * to one entity's anchors, which is how a user disambiguates a shared corner
 * without cycling through all seven of its entities.
 */
export function resolveCandidates(
  hits: readonly { entityKey: string }[],
  entityMateRefs: Readonly<EntityMateRefs>,
  scopeEntityKey?: string | null,
): MateRef[] {
  const out: MateRef[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (scopeEntityKey && hit.entityKey !== scopeEntityKey) continue
    for (const ref of entityMateRefs[hit.entityKey] ?? []) {
      const k = refKey(ref)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(ref)
    }
  }
  return out
}

/** Advance a cycle index, wrapping. An empty set stays at -1 (nothing to commit). */
export function cycleIndex(length: number, index: number): number {
  if (length <= 0) return -1
  return (index + 1) % length
}

/**
 * Whether two resolutions name the same references in the same order. A second
 * Ctrl+click on the pixel that produced the current set means "advance the
 * cycle"; one on a different pixel means "aim somewhere else". Without this the
 * two are indistinguishable and a user could never leave a corner.
 */
export function sameCandidateSet(a: readonly MateRef[], b: readonly MateRef[]): boolean {
  if (a.length !== b.length) return false
  return a.every((ref, i) => refKey(ref) === refKey(b[i]))
}
