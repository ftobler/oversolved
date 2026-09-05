import { MAX_ID } from './idEncoding'
import { markCell, markCellKey, marksCoincide, MARK_CELL_NEIGHBOURS } from './markPosition'

// Upper bound on frees deferred without an intervening render. `bumpCycle()`
// normally promotes `pendingFree` into `freeList` once per ID-buffer render, but
// a canvas that never renders (a background tab with rAF paused, a permanently
// dirty pipeline) never bumps: every re-registration frees then allocates, and
// with an empty free list the allocation consumes `nextId++`, marching toward
// the MAX_ID throw. At the bound the registry promotes on its own so a
// non-rendering canvas recycles ids; well below it the "not reused within a
// dirty cycle" contract is untouched.
//
// Self-promotion is safe only because of an invariant the registry cannot
// enforce itself: every free() caller synchronously marks the pipeline dirty
// before any async decode, and every id-decoding path (readWindow, resolveSync,
// resolveAsync) gates on isDirty(), so a recycled id can never be decoded
// against a still-live ID buffer.
const MAX_PENDING_FREE = 1024

// Shared empty result so the common "this id marks no point" answer allocates
// nothing on a path that runs once per candidate per resolve.
const EMPTY_MARK_IDS: readonly number[] = []

/** Where one id's mark sits. `seq` is the order it was published in, which is
 *  what orders an expansion -- for a sketch that is the entity order, stable
 *  across re-registrations and independent of which draw won the pixel. */
interface MarkPosition {
  x: number
  y: number
  z: number
  cellKey: string
  cell: readonly [number, number, number]
  seq: number
}

/**
 * Central allocator mapping {layer, entityKey} <-> stable 24-bit integer ID.
 *
 * - `entityKey` is the existing ancestral query string for an entity
 *   (e.g. `face@createdBy=extrude1#1`), NOT a transient three.js uuid,
 *   so IDs survive scene re-creation across solver runs.
 * - IDs are session-stable. Freed IDs go on a recycle list but are NOT
 *   handed back out within the same dirty-cycle: `bumpCycle()` must be
 *   called (the pipeline does this on each render) before a freed slot
 *   becomes eligible for reuse. This keeps debugging traces and async
 *   readbacks consistent within a single ID-buffer lifetime. A canvas that
 *   stops rendering still recycles: once `MAX_PENDING_FREE` frees pile up
 *   with no bump, `free()` promotes them itself so `nextId` stays bounded.
 */
export interface IdRecord {
  id: number
  layer: string
  entityKey: string
  /** Allocation identity: unique per rendered primitive. Equals `entityKey` for
   *  layers that pass no explicit pick key. */
  pickKey: string
}

export class IdRegistry {
  private byId = new Map<number, IdRecord>()
  private byKey = new Map<string, number>()  // layer + '\u0000' + entityKey
  private nextId = 1  // 0 is reserved as EMPTY_ID
  // Freed this cycle, eligible next cycle. A Set because `free` is called once per
  // holder of an ID and two holders can legitimately hold ONE ID: allocation keyed
  // by query collapses everything sharing that query, including across bodies, and
  // each body then frees it. An array let the same ID onto `freeList` twice, after
  // which two unrelated entities were handed it and cross-selected. Insertion order
  // is preserved, so recycling order is unchanged apart from the dropped repeats.
  private pendingFree = new Set<number>()
  private freeList: number[] = []  // eligible for reuse now

  // Where each id's mark sits, and who else is there. A point-marking layer
  // publishes its positions here at registration (see `VertexIdLayer`), which is
  // what lets a resolve recover the marks that lost their pixel: a mark one
  // pixel wide has no room to lose an argument, so when two land on the same
  // pixel the later draw does not rank above the earlier one, it ERASES it. The
  // buffer then answers WHERE the cursor is and this answers WHAT is there.
  //
  // Two maps rather than one: the id -> position direction is what a hit has in
  // hand, and the cell -> ids direction is the spatial index a lookup needs.
  // The cell is a bucket, not the answer: co-location is decided by
  // `marksCoincide`, and the cell only bounds how far a lookup has to look.
  private markPositionById = new Map<number, MarkPosition>()
  private idsByMarkCell = new Map<string, number[]>()
  private markSeq = 0

  private composeKey(layer: string, entityKey: string): string {
    return layer + '\u0000' + entityKey
  }

  /**
   * Allocate (or return the existing) ID for a primitive. `pickKey` is the
   * uniqueness key; when omitted it falls back to `entityKey` (still correct
   * for layers whose queries are already unique). Keying on a per-primitive
   * `pickKey` instead of the query is what stops two primitives that share a
   * query from collapsing onto one ID.
   */
  allocate(layer: string, entityKey: string, pickKey: string = entityKey): number {
    const k = this.composeKey(layer, pickKey)
    const existing = this.byKey.get(k)
    if (existing !== undefined) return existing

    const id = this.freeList.length > 0 ? this.freeList.pop()! : this.nextId++
    if (id > MAX_ID) {
      throw new Error(`IdRegistry: exhausted 24-bit ID space (max ${MAX_ID})`)
    }
    const record: IdRecord = { id, layer, entityKey, pickKey }
    this.byId.set(id, record)
    this.byKey.set(k, id)
    return id
  }

  free(id: number): void {
    const record = this.byId.get(id)
    if (!record) return
    // Drop the key index immediately so a re-allocation of the same pickKey
    // gets a fresh ID, but keep the byId record until bumpCycle() so async
    // readbacks pending against the current ID buffer still decode correctly.
    // Only drop the key if it still points at THIS id: one query-keyed id can be
    // co-held by two bodies, and if one body re-registered first the key now
    // names its fresh id, so the other body's free must not orphan it.
    const k = this.composeKey(record.layer, record.pickKey)
    if (this.byKey.get(k) === id) this.byKey.delete(k)
    // Dropped now rather than at bumpCycle, unlike the byId record: a freed id
    // is about to be handed to a re-registered primitive at a possibly different
    // position, and a stale entry would co-locate it with whatever used to be
    // there.
    const mark = this.markPositionById.get(id)
    if (mark !== undefined) this.dropMarkPosition(id, mark.cellKey)
    this.pendingFree.add(id)
    // A non-rendering canvas never calls bumpCycle(); promote here once the
    // deferred set reaches its bound so ids recycle instead of climbing nextId.
    if (this.pendingFree.size >= MAX_PENDING_FREE) this.promotePendingFree()
  }

  lookup(id: number): IdRecord | undefined {
    return this.byId.get(id)
  }

  /**
   * Record where `id`'s mark is drawn, so co-located marks can find each other.
   * Only layers that mark a POINT call this: a curve or a face covers many
   * pixels and cannot be erased by a single overlap, so it has nothing to
   * recover and nothing to contribute.
   *
   * The position is stored at float32, the precision the position attribute is
   * uploaded at, so what is indexed is what is drawn.
   */
  setMarkPosition(id: number, x: number, y: number, z: number): void {
    const fx = Math.fround(x), fy = Math.fround(y), fz = Math.fround(z)
    const prev = this.markPositionById.get(id)
    if (prev && prev.x === fx && prev.y === fy && prev.z === fz) return
    if (prev) this.dropMarkPosition(id, prev.cellKey)
    const cell = markCell(fx, fy, fz)
    const cellKey = markCellKey(cell[0], cell[1], cell[2])
    this.markPositionById.set(id, { x: fx, y: fy, z: fz, cell, cellKey, seq: this.markSeq++ })
    const at = this.idsByMarkCell.get(cellKey)
    if (at) at.push(id)
    else this.idsByMarkCell.set(cellKey, [id])
  }

  /**
   * Every id whose mark shares a position with `id`'s, in registration order and
   * including `id` itself. One element means nothing was co-located; none means
   * `id` marks no point at all.
   *
   * Grown transitively rather than as a flat "everything near `id`": a tolerance
   * is not transitive on its own, so a straight radius query would answer
   * differently depending on which member of a cluster was asked -- and the
   * member being asked is whichever one happened to win the pixel, which is the
   * dependence this index exists to remove. The closure is the same set from
   * every member of it.
   */
  coincidentMarkIds(id: number): readonly number[] {
    const seed = this.markPositionById.get(id)
    if (seed === undefined) return EMPTY_MARK_IDS
    const found: Array<{ id: number; at: MarkPosition }> = [{ id, at: seed }]
    const seen = new Set<number>([id])
    // Index rather than iterator: `found` grows while it is being walked, which
    // is what makes this a closure and not a single-hop query.
    for (let i = 0; i < found.length; i++) {
      const from = found[i].at
      for (const [dx, dy, dz] of MARK_CELL_NEIGHBOURS) {
        const bucket = this.idsByMarkCell.get(
          markCellKey(from.cell[0] + dx, from.cell[1] + dy, from.cell[2] + dz))
        if (!bucket) continue
        for (const other of bucket) {
          if (seen.has(other)) continue
          const at = this.markPositionById.get(other)
          if (!at || !marksCoincide(from.x, from.y, from.z, at.x, at.y, at.z)) continue
          seen.add(other)
          found.push({ id: other, at })
        }
      }
    }
    if (found.length === 1) return [id]
    return found.sort((a, b) => a.at.seq - b.at.seq).map(m => m.id)
  }

  private dropMarkPosition(id: number, cellKey: string): void {
    this.markPositionById.delete(id)
    const at = this.idsByMarkCell.get(cellKey)
    if (!at) return
    const i = at.indexOf(id)
    if (i >= 0) at.splice(i, 1)
    if (at.length === 0) this.idsByMarkCell.delete(cellKey)
  }

  lookupKey(layer: string, entityKey: string): number | undefined {
    return this.byKey.get(this.composeKey(layer, entityKey))
  }

  // Promote pending frees into the reusable pool. Called once per ID-buffer
  // render, and from free() itself when the deferred set reaches its bound.
  bumpCycle(): void {
    this.promotePendingFree()
  }

  private promotePendingFree(): void {
    if (this.pendingFree.size === 0) return
    for (const id of this.pendingFree) {
      this.byId.delete(id)
      this.freeList.push(id)
    }
    this.pendingFree.clear()
  }

  // Number of live entries (entries pending free are not counted).
  size(): number {
    return this.byKey.size
  }

  clear(): void {
    this.byId.clear()
    this.byKey.clear()
    this.markPositionById.clear()
    this.idsByMarkCell.clear()
    this.markSeq = 0
    this.pendingFree.clear()
    this.freeList.length = 0
    this.nextId = 1
  }
}
