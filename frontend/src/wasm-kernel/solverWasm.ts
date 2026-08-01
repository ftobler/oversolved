/**
 * Browser entry points for the Rust solver WASM packages (wasm-pack
 * `--target web` builds).
 *
 * There are TWO packages, not one: `sketch_solver` (sketch solve + topology)
 * and `mate_solver` (assembly mates). They are separate crates compiled to
 * separate binaries so each Worker downloads and compiles only what it calls --
 * the OCC/sketch builder Worker never pays for the mate solver, and the anchor
 * solver Worker never pays for the sketch solver or the topology builder. Their
 * wire formats are independent too (separate magics, separate codecs), so
 * either can version without dragging the other along.
 *
 * Loading is lazy, per-package, and failure-tolerant: the `--target web`
 * packages are gitignored build artifacts served from a configurable base
 * (default `/wasm/`, populated by `scripts/copyWasm.mjs`). If one is absent this
 * resolves to `null` and the caller degrades rather than throwing.
 *
 * The dynamic `import` is `@vite-ignore`d so the production build does not try
 * to resolve or bundle the artifact (which may be absent at build time); the
 * URL is fetched at runtime instead.
 */

import type { SolveBytes } from './codec'
import type { TopologyBytes } from './loadTopology'

interface SketchModule {
  default: (input?: unknown) => Promise<unknown>
  solve_sketch_bytes: SolveBytes
  detect_topology_bytes: TopologyBytes
}

interface MateModule {
  default: (input?: unknown) => Promise<unknown>
  solve_mate_bytes: SolveBytes
}

/** Base URL the `--target web` pkgs are served from. Override per deployment. */
const DEFAULT_BASE = '/wasm/'

/** One entry per package, so a Worker that only mates never inits the sketch
 *  wasm. Keyed by `${base}${stem}`: a test can reload from a different base
 *  without hitting a stale entry. */
const moduleCache = new Map<string, Promise<unknown>>()

/** Load + init one wasm-pack `--target web` package, once per key. */
function loadPackage<M>(stem: string, base: string): Promise<M | null> {
  const key = `${base}${stem}`
  const hit = moduleCache.get(key)
  if (hit) return hit as Promise<M | null>
  const pending = (async () => {
    try {
      const mod = (await import(  /* @vite-ignore */ `${base}${stem}.js`)) as M & {
        default: (input?: unknown) => Promise<unknown>
      }
      // The web build needs its init() called once (fetches the .wasm).
      await mod.default(`${base}${stem}_bg.wasm`)
      return mod
    } catch (e) {
      console.error(`[solverWasm] loading ${stem} failed:`, e)
      return null
    }
  })()
  moduleCache.set(key, pending)
  return pending
}

/** Browser loader for the Rust sketch solver (`solve_sketch_bytes`). */
export function loadSolverWasm(base = DEFAULT_BASE): Promise<SolveBytes | null> {
  return loadPackage<SketchModule>('sketch_solver', base).then((m) => m?.solve_sketch_bytes ?? null)
}

/** Browser loader for the Rust area builder (`detect_topology_bytes`). Shares
 *  the sketch package: topology and solve cross the boundary independently but
 *  ship in one binary, both being sketch-side concerns. */
export function loadTopologyWasm(base = DEFAULT_BASE): Promise<TopologyBytes | null> {
  return loadPackage<SketchModule>('sketch_solver', base).then((m) => m?.detect_topology_bytes ?? null)
}

/** Browser loader for the Rust mate solver (`solve_mate_bytes`), a separate
 *  package from the sketch one -- see the module header. */
export function loadMateWasm(base = DEFAULT_BASE): Promise<SolveBytes | null> {
  return loadPackage<MateModule>('mate_solver', base).then((m) => m?.solve_mate_bytes ?? null)
}

/** Reset every memoized package loader (tests / hot-reload). */
export function resetSolverWasm(): void {
  moduleCache.clear()
}
