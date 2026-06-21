/**
 * Browser entry point for the Rust sketch solver (wasm-pack `--target web`
 * build). The live app (eventually a builder Worker) calls `loadSolverWasm`
 * once, then drives `compareSketch` / the solver via the returned `solveBytes`.
 *
 * Loading is lazy and failure-tolerant: the `--target web` package is a
 * gitignored build artifact served at a configurable URL (default `/wasm/`,
 * populated by a build/copy step from `sketch-solver/pkg`). If it is not
 * present, this resolves to `null` and the caller simply does not run the
 * shadow comparison -- it never breaks the real (Python) solve path.
 *
 * The dynamic `import` is `@vite-ignore`d so the production build does not try
 * to resolve or bundle the artifact (which may be absent at build time); the
 * URL is fetched at runtime instead.
 *
 * NOTE: wiring this into the live solve path additionally needs the phase-2c
 * query/projection resolution (to lower arbitrary live PartDocs, not just the
 * resolved corpus) and a build step that copies the web pkg under the served
 * `/wasm/` path. See `shadowCompare.ts`.
 */

import type { SolveBytes } from './codec'
import type { TopologyBytes } from './loadTopology'

interface WebModule {
  default: (input?: unknown) => Promise<unknown>
  solve_sketch_bytes: SolveBytes
  detect_topology_bytes: TopologyBytes
}

/** Base URL the `--target web` pkg is served from. Override per deployment. */
const DEFAULT_BASE = '/wasm/'

let moduleCache: Promise<WebModule | null> | null = null

/** Load + init the web wasm module once; both entry points share it. */
function loadWebModule(base: string): Promise<WebModule | null> {
  if (moduleCache) return moduleCache
  moduleCache = (async () => {
    try {
      const mod = (await import(/* @vite-ignore */ `${base}sketch_solver.js`)) as WebModule
      // The web build needs its init() called once (fetches the .wasm).
      await mod.default(`${base}sketch_solver_bg.wasm`)
      return mod
    } catch {
      return null
    }
  })()
  return moduleCache
}

function loadWasmExport<T extends keyof WebModule>(key: T, base: string = DEFAULT_BASE): Promise<WebModule[T] | null> {
  return loadWebModule(base).then((m) => m?.[key] ?? null)
}

export function loadSolverWasm(base = DEFAULT_BASE): Promise<SolveBytes | null> {
  return loadWasmExport('solve_sketch_bytes', base)
}

/** Browser loader for the Rust area builder (`detect_topology_bytes`). */
export function loadTopologyWasm(base = DEFAULT_BASE): Promise<TopologyBytes | null> {
  return loadWasmExport('detect_topology_bytes', base)
}

/** Reset the memoized loader (tests / hot-reload). */
export function resetSolverWasm(): void {
  moduleCache = null
}
