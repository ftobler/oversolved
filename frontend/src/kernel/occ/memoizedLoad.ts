/**
 * Memoize an async loader so its work runs at most once per successful result:
 * the first `load` call invokes `loader` (with that call's args) and caches the
 * returned promise; later calls return the cached promise and ignore their args.
 * A null (or rejected) result is NOT pinned: the loaders' "artifact absent /
 * failed" signal is treated as a miss and the cell is evicted so the next call
 * retries, mirroring solverWasm's failed-load eviction. `reset` clears the
 * cache for tests and hot-reload.
 *
 * Collapses the per-loader `let cached` / `if (cached) return cached` /
 * `cached = (async () => ...)()` / `reset()` boilerplate the OCC module loaders
 * each carried.
 */
export function memoizedLoad<A extends unknown[], T>(
  loader: (...args: A) => Promise<T | null>,
): { load: (...args: A) => Promise<T | null>; reset: () => void } {
  let cached: Promise<T | null> | null = null
  return {
    load: (...args: A) => {
      if (cached) return cached
      const pending = loader(...args)
      cached = pending
      // A null result or a rejection must not pin the cell: evict so the next
      // call retries. The identity check keeps a `reset` (or a newer load racing
      // this resolution) from having its fresh cell evicted by this stale
      // callback.
      pending.then(
        (res) => { if (res == null && cached === pending) cached = null },
        () => { if (cached === pending) cached = null },
      )
      return pending
    },
    reset: () => { cached = null },
  }
}
