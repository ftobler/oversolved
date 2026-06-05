/**
 * Port of ``_solve_sketch`` / ``_dispatch_sketch`` (solver_features_sketch.py):
 * the sketch constraint solver backed by the Rust WASM kernel.
 *
 * Takes a sketch feature in the live PartDoc format (``$``-ref constraints,
 * optional ``source`` on projected entities, ``center_rect`` sugar) and lowers
 * it through the same pipeline the shadow comparator uses. Returns a result
 * dict compatible with ``applySolveResult`` so downstream features can
 * reference the solved geometry via the repository.
 *
 * The WASM binary is loaded asynchronously once (``initSketchSolver()``) and
 * cached; the actual ``solveSketch`` call is synchronous. When the binary is
 * unavailable (not provisioned under ``/wasm/``), ``solveSketch`` throws so the
 * builder's try/catch returns a clean exception — the caller can then fall back
 * to the Python daemon.
 *
 * Projected entities and center_rect sugar are not yet lowered; sketches
 * containing them throw a descriptive error.
 */

import type { PartFeature } from '@/types/cad'
import type { Repository } from '../query'
import type { Body } from '../types3d'
import { partDocToSketches } from '@/wasm-kernel/partDocToSketches'
import { lowerSketch } from '@/wasm-kernel/lowerSketch'
import { encodeInput, decodeOutput, STATUS_NAME } from '@/wasm-kernel/codec'
import { loadSolverWasm } from '@/wasm-kernel/solverWasm'
import type { SolveBytes } from '@/wasm-kernel/shadowCompare'

type Dict = Record<string, unknown>

export interface SketchResult {
  [key: string]: unknown
  status: string
  geometry?: Record<string, number[]>
  features?: Record<string, { status: string }>
}

let solverBytes: SolveBytes | null = null
let solverLoading: Promise<SolveBytes | null> | null = null

/** Start loading the Rust solver. Safe to call multiple times. */
export async function initSketchSolver(): Promise<SolveBytes | null> {
  if (solverBytes) return solverBytes
  if (!solverLoading) {
    solverLoading = loadSolverWasm().then((b) => {
      solverBytes = b
      return b
    })
  }
  return solverLoading
}

/** Clear the cached solver (tests). */
export function resetSketchSolver(): void {
  solverBytes = null
  solverLoading = null
}

/**
 * Solve a single sketch feature with the Rust kernel. Must call
 * ``initSketchSolver()`` first; throws if the solver is not loaded.
 * Returns a result compatible with Python's ``_dispatch_sketch`` output.
 */
export function solveSketch(
  feature: Dict,
  _globalRepo: Repository,
  _bodyStore: Record<string, Body>,
): SketchResult {
  if (!solverBytes) {
    throw new Error('sketch: Rust solver not initialised (call initSketchSolver first)')
  }

  const featureId = (feature.id as string) ?? ''

  // Lower the live PartDoc feature to SketchInput (resolves $refs -> dict).
  const pf = feature as unknown as PartFeature
  const extract = partDocToSketches([pf])
  if (extract.skipped.length) {
    throw new Error(`sketch '${featureId}': ${extract.skipped[0].reason}`)
  }
  if (!extract.sketches.length) {
    throw new Error(`sketch '${featureId}': no lowerable sketch found`)
  }

  const { sketch } = extract.sketches[0]
  const { input, layout } = lowerSketch(sketch)
  const out = decodeOutput(solverBytes(encodeInput(input)))
  const status = STATUS_NAME[out.overallStatus]

  // Reconstruct per-entity geometry and status maps.
  const geometry: Record<string, number[]> = {}
  const features: Record<string, { status: string }> = {}
  for (let i = 0; i < layout.length; i++) {
    const ent = layout[i]
    const params = out.paramsSolved.slice(ent.offset, ent.offset + ent.size)
    if (Math.abs(params[0]) > 1e-12 || params.length > 1) {
      geometry[ent.id] = [...params]
    }
    const entStatus = STATUS_NAME[out.entityStatus[i]]
    features[ent.id] = { status: entStatus }
  }

  return {
    status,
    geometry,
    features,
    solve_ms: 0,
  }
}
