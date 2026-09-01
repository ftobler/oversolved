import { MAX_ID } from './idEncoding'

// Shared empty result so the common "this id marks no point" answer allocates
// nothing on a path that runs once per candidate per resolve.
const EMPTY_MARK_IDS: readonly number[] = []

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
 *   readbacks consistent within a single ID-buffer lifetime.
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
  // Two maps rather than one: the id -> key direction is what a hit has in
  // hand, and the key -> ids direction has to preserve registration order so an
  // expansion is deterministic rather than dependent on which draw won the pixel.
  private markPositionById = new Map<number, string>()
  private idsByMarkPosition = new Map<string, number[]>()

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
    this.byKey.delete(this.composeKey(record.layer, record.pickKey))
    // Dropped now rather than at bumpCycle, unlike the byId record: a freed id
    // is about to be handed to a re-registered primitive at a possibly different
    // position, and a stale entry would co-locate it with whatever used to be
    // there.
    const markKey = this.markPositionById.get(id)
    if (markKey !== undefined) this.dropMarkPosition(id, markKey)
    this.pendingFree.add(id)
  }

  lookup(id: number): IdRecord | undefined {
    return this.byId.get(id)
  }

  /**
   * Record where `id`'s mark is drawn, so co-located marks can find each other.
   * Only layers that mark a POINT call this: a curve or a face covers many
   * pixels and cannot be erased by a single overlap, so it has nothing to
   * recover and nothing to contribute.
   */
  setMarkPosition(id: number, key: string): void {
    const prev = this.markPositionById.get(id)
    if (prev === key) return
    if (prev !== undefined) this.dropMarkPosition(id, prev)
    this.markPositionById.set(id, key)
    const at = this.idsByMarkPosition.get(key)
    if (at) at.push(id)
    else this.idsByMarkPosition.set(key, [id])
  }

  /**
   * Every id whose mark shares a position with `id`'s, in registration order and
   * including `id` itself. One element means nothing was co-located; none means
   * `id` marks no point at all.
   */
  coincidentMarkIds(id: number): readonly number[] {
    const key = this.markPositionById.get(id)
    if (key === undefined) return EMPTY_MARK_IDS
    return this.idsByMarkPosition.get(key) ?? EMPTY_MARK_IDS
  }

  private dropMarkPosition(id: number, key: string): void {
    this.markPositionById.delete(id)
    const at = this.idsByMarkPosition.get(key)
    if (!at) return
    const i = at.indexOf(id)
    if (i >= 0) at.splice(i, 1)
    if (at.length === 0) this.idsByMarkPosition.delete(key)
  }

  lookupKey(layer: string, entityKey: string): number | undefined {
    return this.byKey.get(this.composeKey(layer, entityKey))
  }

  // Promote pending frees into the reusable pool. Called once per ID-buffer render.
  bumpCycle(): void {
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
    this.idsByMarkPosition.clear()
    this.pendingFree.clear()
    this.freeList.length = 0
    this.nextId = 1
  }
}
