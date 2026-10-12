// Topological-identity indexes over OccSubShape handles. OCC's HashCode is
// TShape-derived and orientation-independent, matching IsSame, so these bucket
// identities in one crossing each and confirm the bucket with IsSame because the
// hash is bounded and can (rarely) collide. They are OCC-free apart from the
// shape handles, so they live in this leaf module and are re-exported from
// primitives.ts for the existing callers.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape } from './occTypes'

/** Upper bound handed to `TopoDS_Shape.HashCode`. The largest signed 32-bit int
 *  spreads TShapes across the full range so identity buckets stay tiny. */
const SHAPE_HASH_UPPER = 2147483647  // 2^31 - 1

/**
 * O(n) topological-identity dedup for TopExp_Explorer output. A solid's explorer
 * yields each shared edge/vertex once per owning face, so a growing-array
 * `some(IsSame)` scan is O(n^2) in C++/JS boundary crossings (a 12k-edge STEP
 * import is ~150M IsSame calls). OCC's `HashCode` is TShape-derived and
 * orientation-independent, matching `IsSame`, so it buckets identities in one
 * crossing each; the bucket is confirmed with `IsSame` because the hash is
 * bounded and can (rarely) collide, keeping the result exactly correct.
 */
export class SubShapeDedup {
  private readonly buckets = new Map<number, OccSubShape[]>()
  // Synthetic shapes (unit-test mocks) may lack HashCode; fall back to a flat
  // IsSame scan so the helper still dedups without a real OCC TShape.
  private readonly flat: OccSubShape[] = []
  // Register a shape; returns true the first time this identity is seen.
  add(shape: OccSubShape): boolean {
    const hashFn = (shape as unknown as { HashCode?: (n: number) => number }).HashCode
    if (typeof hashFn !== 'function') {
      if (this.flat.some((u) => u.IsSame(shape))) return false
      this.flat.push(shape)
      return true
    }
    const key = hashFn.call(shape, SHAPE_HASH_UPPER)
    const bucket = this.buckets.get(key)
    if (bucket === undefined) {
      this.buckets.set(key, [shape])
      return true
    }
    if (bucket.some((u) => u.IsSame(shape))) return false
    bucket.push(shape)
    return true
  }
  // Pure membership test, read-only. `add` doubles as one only while the query
  // set never grows; the boolean lineage passes pre-seed a pool then query NEW
  // shapes against it, where `add` would register the queries and reclassify
  // their second explorer occurrence (every shared new edge appears twice).
  has(shape: OccSubShape): boolean {
    const hashFn = (shape as unknown as { HashCode?: (n: number) => number }).HashCode
    if (typeof hashFn !== 'function') return this.flat.some((u) => u.IsSame(shape))
    const bucket = this.buckets.get(hashFn.call(shape, SHAPE_HASH_UPPER))
    return bucket !== undefined && bucket.some((u) => u.IsSame(shape))
  }
}

/**
 * O(1)-amortised map from a sub-shape's topological identity to an index,
 * the lookup counterpart to `SubShapeDedup`. Same `HashCode` bucketing so a
 * per-face `sortedEdges.findIndex(IsSame)` (O(F x E x E)) collapses to one
 * hash + a tiny bucket scan. Buckets are confirmed with `IsSame` because the
 * hash is bounded and can (rarely) collide, keeping the result exact.
 */
export class SubShapeIndexMap {
  private readonly buckets = new Map<number, { shape: OccSubShape; index: number }[]>()
  // Record `shape -> index`; later duplicates of the same identity are kept but never win a lookup.
  set(shape: OccSubShape, index: number): void {
    const key = shape.HashCode(SHAPE_HASH_UPPER)
    const bucket = this.buckets.get(key)
    if (bucket === undefined) {
      this.buckets.set(key, [{ shape, index }])
      return
    }
    if (bucket.some((b) => b.shape.IsSame(shape))) return
    bucket.push({ shape, index })
  }
  // Index registered for this identity, or -1 if none.
  get(shape: OccSubShape): number {
    const bucket = this.buckets.get(shape.HashCode(SHAPE_HASH_UPPER))
    if (bucket === undefined) return -1
    const hit = bucket.find((b) => b.shape.IsSame(shape))
    return hit ? hit.index : -1
  }
}

/**
 * Every value registered under a sub-shape's topological identity, not just the
 * first -- the multi-valued counterpart to `SubShapeIndexMap`. Same HashCode
 * bucketing, same IsSame bucket confirm, so a `pairs.filter((p) => x.IsSame(p.k))`
 * inside a loop over `pairs`'s own key space collapses from O(n^2) crossings to
 * O(n) hashes.
 *
 * `stepIo`'s `UnplacedFaceIndex` hand-rolls this same map over a
 * `SubShapeIndexMap`; it is left alone because its identity semantics are
 * placement-sensitive in ways this map is not, but the general shape is here.
 */
export class SubShapeMultiIndex<T> {
  private readonly buckets = new Map<number, { shape: OccSubShape; values: T[] }[]>()
  // Record `shape -> value`, appending to the identity's value list so `get`
  // returns values in insertion order (Change 4b's `find(!fromTool) ?? matches[0]`
  // tie-break depends on it).
  add(shape: OccSubShape, value: T): void {
    const key = shape.HashCode(SHAPE_HASH_UPPER)
    const bucket = this.buckets.get(key)
    if (bucket === undefined) {
      this.buckets.set(key, [{ shape, values: [value] }])
      return
    }
    const entry = bucket.find((b) => b.shape.IsSame(shape))
    if (entry !== undefined) {
      entry.values.push(value)
      return
    }
    bucket.push({ shape, values: [value] })
  }
  // Every value registered for this identity, or [] when unknown.
  get(shape: OccSubShape): readonly T[] {
    const bucket = this.buckets.get(shape.HashCode(SHAPE_HASH_UPPER))
    if (bucket === undefined) return []
    const entry = bucket.find((b) => b.shape.IsSame(shape))
    return entry !== undefined ? entry.values : []
  }
}

/**
 * A mutable map from a sub-shape's topological identity to one value: set
 * overwrites, delete removes. The construction names a producer builds are
 * held in one (`bodyNames.ts`), keyed by the sub-shape itself rather than by
 * anything derived from its geometry. Same HashCode bucketing and IsSame
 * confirm as the indexes above; placement-sensitive, like plain `IsSame`.
 */
export class SubShapeMap<T> {
  private readonly buckets = new Map<number, { shape: OccSubShape; value: T }[]>()
  private count = 0

  // A copy of `from`'s entries (the shapes are shared, the map is not).
  constructor(from?: SubShapeMap<T>) {
    if (from !== undefined) this.assign(from)
  }

  // Set every entry of `from` here, overwriting: Object.assign for identity keys.
  assign(from: SubShapeMap<T>): this {
    for (const [shape, value] of from.entries()) this.set(shape, value)
    return this
  }

  get size(): number {
    return this.count
  }

  get(shape: OccSubShape): T | undefined {
    return this.entry(shape)?.value
  }

  has(shape: OccSubShape): boolean {
    return this.entry(shape) !== undefined
  }

  set(shape: OccSubShape, value: T): void {
    const key = shape.HashCode(SHAPE_HASH_UPPER)
    const bucket = this.buckets.get(key)
    if (bucket === undefined) {
      this.buckets.set(key, [{ shape, value }])
      this.count++
      return
    }
    const hit = bucket.find((b) => b.shape.IsSame(shape))
    if (hit !== undefined) {
      hit.value = value
      return
    }
    bucket.push({ shape, value })
    this.count++
  }

  delete(shape: OccSubShape): boolean {
    const key = shape.HashCode(SHAPE_HASH_UPPER)
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return false
    const at = bucket.findIndex((b) => b.shape.IsSame(shape))
    if (at < 0) return false
    bucket.splice(at, 1)
    if (bucket.length === 0) this.buckets.delete(key)
    this.count--
    return true
  }

  // Entries in insertion order within a bucket; callers must not depend on the order.
  *entries(): IterableIterator<[OccSubShape, T]> {
    for (const bucket of this.buckets.values()) for (const b of bucket) yield [b.shape, b.value]
  }

  // The values alone, in the same unspecified order as `entries`.
  *values(): IterableIterator<T> {
    for (const [, value] of this.entries()) yield value
  }

  private entry(shape: OccSubShape): { shape: OccSubShape; value: T } | undefined {
    return this.buckets.get(shape.HashCode(SHAPE_HASH_UPPER))?.find((b) => b.shape.IsSame(shape))
  }
}

/**
 * Strip a shape's placement, so `IsSame` and `HashCode` compare TShapes alone.
 *
 * Needed because a STEP file with several roots comes back with each root under
 * its own `TopLoc_Location`, and the transfer binders hold the UNPLACED faces:
 * across a two-solid file, binder face vs explorer face is `IsPartner` for all
 * 12 and `IsSame` for none, so a plain `SubShapeIndexMap` silently matched
 * nothing and the whole import went unnamed. Both sides are normalised here.
 *
 * Two placements of ONE part (a repeated assembly instance) therefore collapse
 * to the same key. That is handled, not tolerated: `UnplacedFaceIndex` hands
 * the entity id to every instance, and the per-solid index folded into the UUID
 * path keeps their queries apart.
 *
 * `keep` copies live in `scope` because the index holds them; `borrow` is for a
 * lookup that ends inside the callback, and releases immediately.
 */
export function unplacer(oc: OccModule, scope: DisposeScope): {
  keep: (shape: OccShape) => OccSubShape
  borrow: <T>(shape: OccShape, read: (bare: OccSubShape) => T) => T
} {
  const identity = scope.track(new oc.TopLoc_Location_1())
  const strip = (shape: OccShape): OccSubShape => (shape as OccSubShape).Located(identity) as OccSubShape
  return {
    keep: (shape) => scope.track(strip(shape)),
    borrow: (shape, read) => {
      const bare = strip(shape)
      try {
        return read(bare)
      } finally {
        bare.delete()
      }
    },
  }
}
