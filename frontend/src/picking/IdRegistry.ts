import { MAX_ID } from './idEncoding'

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
    this.pendingFree.add(id)
  }

  lookup(id: number): IdRecord | undefined {
    return this.byId.get(id)
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
    this.pendingFree.clear()
    this.freeList.length = 0
    this.nextId = 1
  }
}
