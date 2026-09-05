/**
 * RAII-style arena for short-lived OCC.js objects.
 *
 * OCC.js (opencascade.js) hands back embind proxies for every `TopoDS_Shape`,
 * builder, explorer, point, vector, etc. Each owns C++ memory and must be
 * `.delete()`d or the WASM heap leaks. Most of these are transient: a builder
 * or explorer lives for the span of a single operation. A `DisposeScope`
 * collects them and deletes them all when the operation ends, in reverse
 * construction order, so a single early-return or throw cannot strand handles.
 *
 * Shapes that must outlive the operation (a body stored in a checkpoint) are
 * NOT tracked here; they go into the refcounted [[HandleTable]] instead. Use
 * `detach()` to hand a shape out of the scope when ownership transfers to the
 * table.
 */

import type { OccShape, OccListOfShape } from './occTypes'

/** Anything OCC.js (or a test double) hands back that owns native memory. */
export interface Disposable {
  delete(): void
  // opencascade.js embind proxies expose this; test doubles may too.
  isDeleted?(): boolean
}

export class DisposeScope {
  private readonly tracked: Disposable[] = []
  private disposed = false

  // Register `obj` for deletion at `dispose()`; returns it for chaining.
  track<T extends Disposable>(obj: T): T {
    if (this.disposed) {
      throw new Error('DisposeScope: track() after dispose()')
    }
    this.tracked.push(obj)
    return obj
  }

  /**
   * Remove `obj` from the scope so `dispose()` will not delete it. Used when
   * ownership of a shape transfers out of the operation (e.g. into the
   * HandleTable as a persisted body).
   *
   * Throws when `obj` was never tracked: a silent no-op detach means the
   * caller is handing away a shape it does not own, and registering it puts a
   * second owner on a proxy someone else will delete. Producers return
   * untracked shapes by contract (primitives.ts) -- register those directly.
   */
  detach<T extends Disposable>(obj: T): T {
    const i = this.tracked.lastIndexOf(obj)
    if (i < 0) {
      throw new Error('DisposeScope: detach() of an untracked object')
    }
    this.tracked.splice(i, 1)
    return obj
  }

  // True when `obj` is currently tracked by this scope.
  isTracked(obj: Disposable): boolean {
    return this.tracked.includes(obj)
  }

  /**
   * Delete an intermediate NOW and drop it from the scope, instead of letting
   * it ride until dispose(). For consumed intermediates on repeated builds (a
   * wire folded into a face, the previous tool of a fuse chain): tracked-only
   * lifetimes still free them at dispose, but per-edit builds would stack one
   * live proxy each for the whole worker session. Safe to call on an object
   * tracked more than once or never: every tracking entry is dropped and a
   * foreign object is simply deleted. Best-effort like dispose(); a failed
   * early free must not break the build.
   */
  release<T extends Disposable>(obj: T): T {
    for (let i = this.tracked.lastIndexOf(obj); i >= 0; i = this.tracked.lastIndexOf(obj)) {
      this.tracked.splice(i, 1)
    }
    try {
      if (!(obj.isDeleted?.() ?? false)) obj.delete()
    } catch {
      // best-effort: keep building with whatever memory was reclaimable
    }
    return obj
  }

  // Number of objects still tracked (i.e. that dispose() would delete).
  size(): number {
    return this.tracked.length
  }

  /**
   * Delete every tracked object in reverse construction order. Idempotent.
   * A failed `.delete()` on one object does not prevent the rest from being
   * deleted: leaking the rest of a scope would be strictly worse.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (let i = this.tracked.length - 1; i >= 0; i--) {
      const obj = this.tracked[i]
      try {
        if (!(obj.isDeleted?.() ?? false)) obj.delete()
      } catch {
        // best-effort: one bad delete must not strand the remaining handles
      }
    }
    this.tracked.length = 0
  }
}

/**
 * Run `fn` against a child scope disposed the moment it returns or throws, so a
 * per-face or per-edge geometry read leaves nothing behind on the build-lifetime
 * scope. `features/bodyOps.ts:120-144` already does this by hand for its
 * intersection probe; this names the shape of it.
 *
 * The result must be plain data -- numbers, strings, arrays of them. A proxy
 * returned through here is freed before the caller can read it, and no type can
 * say so; the reviewer's job is to check the return type is not an Occ* handle.
 */
export function withTransientScope<T>(fn: (s: DisposeScope) => T): T {
  const s = new DisposeScope()
  try {
    return fn(s)
  } finally {
    s.dispose()
  }
}

/** Drain a TopTools_ListOfShape into an array (Size/First_1/RemoveFirst). */
export function drainList(scope: DisposeScope, list: OccListOfShape): OccShape[] {
  scope.track(list)  // the list container itself owns native memory too
  const out: OccShape[] = []
  const n = list.Size()
  for (let i = 0; i < n; i++) {
    out.push(scope.track(list.First_1()))
    list.RemoveFirst()
  }
  return out
}
