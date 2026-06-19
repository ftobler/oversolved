/**
 * Refcounted handle table for OCC.js shapes that outlive a single operation.
 *
 * The Python kernel got memory management for free: `_copy_shape`
 * (`builder.py`) made a `BRepBuilderAPI_Copy` per checkpoint and CPython
 * refcounts evicted it when the last dict dropped it. OCC.js has no such net.
 * Every `TopoDS_Shape` handle stored in a checkpoint must be `.delete()`d
 * exactly once, after the last checkpoint referencing it is evicted, and
 * never before (shapes are shared across checkpoints via lineage/ancestry,
 * so the same handle is held by several snapshots at once).
 *
 * This table is that net. The builder owns shapes through opaque
 * [[OccHandle]]s; each checkpoint records the handles it holds (cheap) and
 * `retain`s them; evicting a checkpoint `releaseOwner`s its feature id, which
 * decrements every handle it held and `.delete()`s the ones that hit zero.
 *
 * The handle-leak fixture test built on this is the entire memory-safety
 * story for phase 2, per the migration plan: a green leak gate in CI, not a
 * code review, is what proves we did not strand a handle.
 */

import type { Disposable } from './disposeScope'

/** Opaque, branded handle into a [[HandleTable]]. Never do arithmetic on it. */
export type OccHandle = number & { readonly __occHandle: unique symbol }

interface Slot {
  obj: Disposable
  refcount: number
  owners: Set<string>
}

export interface LeakInfo {
  handle: OccHandle
  refcount: number
  owners: string[]
}

export interface HandleTableOptions {
  /**
   * Enable the FinalizationRegistry leak guard. Defaults to dev builds only.
   * The guard fires when a registered proxy is garbage-collected while the
   * table still believes it is live -- i.e. a handle reference was dropped
   * without `release`. It is a best-effort dev signal (GC timing is not
   * deterministic), not the CI gate; `assertNoLeaks()` is the gate.
   */
  finalizerGuard?: boolean
  /** Sink for guard-detected leaks. Defaults to `console.warn`. */
  onLeak?: (info: LeakInfo) => void
}

function isDevBuild(): boolean {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
  } catch {
    return false
  }
}

function defaultOnLeak(info: LeakInfo): void {
  console.warn(
    `HandleTable leak: handle ${info.handle} (refcount ${info.refcount}, ` +
      `owners [${info.owners.join(', ')}]) was garbage-collected while still live. ` +
      'A reference was dropped without release().',
  )
}

export class HandleTable {
  private readonly slots = new Map<number, Slot>()
  private nextId = 1
  private readonly registry?: FinalizationRegistry<number>
  private readonly onLeak: (info: LeakInfo) => void

  constructor(opts: HandleTableOptions = {}) {
    this.onLeak = opts.onLeak ?? defaultOnLeak
    const guard = opts.finalizerGuard ?? isDevBuild()
    if (guard && typeof FinalizationRegistry !== 'undefined') {
      this.registry = new FinalizationRegistry((heldId: number) => {
        const slot = this.slots.get(heldId)
        if (slot && slot.refcount > 0) {
          this.onLeak({
            handle: heldId as OccHandle,
            refcount: slot.refcount,
            owners: [...slot.owners],
          })
        }
      })
    }
  }

  /**
   * Take ownership of `obj` at refcount 1. `owner` (a feature id) lets
   * `releaseOwner` later drop every handle a checkpoint held in one call.
   */
  register(obj: Disposable, owner?: string): OccHandle {
    const id = this.nextId++
    const owners = new Set<string>()
    if (owner !== undefined) owners.add(owner)
    this.slots.set(id, { obj, refcount: 1, owners })
    this.registry?.register(obj as object, id, obj as object)
    return id as OccHandle
  }

  private slot(h: OccHandle): Slot {
    const s = this.slots.get(h)
    if (!s) {
      throw new Error(`HandleTable: handle ${h} is not live (use-after-free or double-release?)`)
    }
    return s
  }

  /** Return the live object behind `h`; throws if it was already finalized. */
  get<T extends Disposable = Disposable>(h: OccHandle): T {
    return this.slot(h).obj as T
  }

  /** True if `h` is still live. */
  has(h: OccHandle): boolean {
    return this.slots.has(h)
  }

  /** Add a reference (optionally crediting it to `owner`); returns `h`. */
  retain(h: OccHandle, owner?: string): OccHandle {
    const s = this.slot(h)
    s.refcount++
    if (owner !== undefined) s.owners.add(owner)
    return h
  }

  /** Drop one reference; finalizes (`.delete()`) when the count reaches zero. */
  release(h: OccHandle): void {
    const s = this.slot(h)
    s.refcount--
    if (s.refcount <= 0) this.finalize(h, s)
  }

  /**
   * Drop the reference every handle holds for `owner` (checkpoint eviction).
   * Handles still referenced by another owner survive; handles that hit zero
   * are finalized.
   */
  releaseOwner(owner: string): void {
    for (const [id, s] of [...this.slots]) {
      if (s.owners.delete(owner)) {
        s.refcount--
        if (s.refcount <= 0) this.finalize(id as OccHandle, s)
      }
    }
  }

  private finalize(h: OccHandle, s: Slot): void {
    this.slots.delete(h)
    this.registry?.unregister(s.obj as object)
    try {
      if (!(s.obj.isDeleted?.() ?? false)) s.obj.delete()
    } catch {
      // best-effort: a failed native delete must not abort eviction of the rest
    }
  }

  /** Number of live handles. */
  liveCount(): number {
    return this.slots.size
  }

  /** Snapshot of live handles, for diagnostics / leak reporting. */
  liveHandles(): LeakInfo[] {
    return [...this.slots.entries()].map(([id, s]) => ({
      handle: id as OccHandle,
      refcount: s.refcount,
      owners: [...s.owners],
    }))
  }

  /** Throw if any handle is still live. The CI leak-gate assertion. */
  assertNoLeaks(): void {
    if (this.slots.size === 0) return
    const detail = this.liveHandles()
      .map((l) => `${l.handle}(rc=${l.refcount}, owners=[${l.owners.join(',')}])`)
      .join(', ')
    throw new Error(`HandleTable: ${this.slots.size} leaked handle(s): ${detail}`)
  }

  /**
   * Delete every remaining handle regardless of refcount. For Worker teardown
   * / crash recovery, where we discard the whole table and reinstantiate.
   */
  disposeAll(): void {
    for (const [id, s] of [...this.slots]) {
      this.finalize(id as OccHandle, s)
    }
  }
}
