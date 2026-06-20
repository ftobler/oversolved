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
  /** opencascade.js embind proxies expose this; test doubles may too. */
  isDeleted?(): boolean
}

export class DisposeScope {
  private readonly tracked: Disposable[] = []
  private disposed = false

  /** Register `obj` for deletion at `dispose()`; returns it for chaining. */
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
   */
  detach<T extends Disposable>(obj: T): T {
    const i = this.tracked.lastIndexOf(obj)
    if (i >= 0) this.tracked.splice(i, 1)
    return obj
  }

  /** Number of objects still tracked (i.e. that dispose() would delete). */
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
 * Run `fn` with a fresh scope and dispose it afterwards, even on throw. Detach
 * anything that must survive (`scope.detach(shape)`) before returning it.
 */
export function withScope<T>(fn: (scope: DisposeScope) => T): T {
  const scope = new DisposeScope()
  try {
    return fn(scope)
  } finally {
    scope.dispose()
  }
}

/** Drain a TopTools_ListOfShape into an array (Size/First_1/RemoveFirst). */
export function drainList(scope: DisposeScope, list: OccListOfShape): OccShape[] {
  const out: OccShape[] = []
  const n = list.Size()
  for (let i = 0; i < n; i++) {
    out.push(scope.track(list.First_1()))
    list.RemoveFirst()
  }
  return out
}
