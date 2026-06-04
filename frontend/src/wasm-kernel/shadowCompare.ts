/**
 * Reusable shadow-mode comparison: solve one sketch with the Rust kernel and
 * diff it against the canonical Python result. This is the core the parity test
 * uses today and that the live in-app shadow path will call once arbitrary docs
 * can be lowered (see note below).
 *
 * The `solveBytes` function is injected (the wasm entry point) so this module is
 * agnostic to how the wasm was loaded -- `loadSolver` (nodejs, tests) or
 * `solverWasm` (browser). It never throws on a solver disagreement; it reports
 * one in the returned diff.
 *
 * NOTE on live wiring: `lowerSketch` expects constraint refs in resolved
 * dict form (`{entity, point}`). The live PartDoc carries query-string refs
 * (`$line1start`, `entity:feat:id`, ancestral/projection queries) that the
 * backend resolves via the repo. Lowering those faithfully is the query /
 * projection resolution slated for phase 2c of the migration; until it lands,
 * this compare runs against the resolved corpus (the regression baseline).
 */

import { decodeOutput, encodeInput, STATUS_NAME } from './codec'
import { lowerSketch, ORIGIN_ID, type SketchInput } from './lowerSketch'

export type SolveBytes = (input: Uint8Array) => Uint8Array

export interface PythonSketchResult {
  status: string
  geometry?: Record<string, number[]>
  features?: Record<string, { status: string }>
}

export interface EntityStatusMismatch {
  id: string
  rust: string
  python: string
}

export interface GeometryMismatch {
  id: string
  rust: number[]
  python: number[]
  maxDelta: number
}

export interface ShadowDiff {
  /** Overall status agreement and feasibility and geometry-where-determinate. */
  ok: boolean
  rustStatus: string
  pythonStatus: string
  residualNorm: number
  statusMatch: boolean
  feasible: boolean
  entityStatusMismatches: EntityStatusMismatch[]
  geometryMismatches: GeometryMismatch[]
}

const FEASIBLE_TOL = 1e-4
const GEOMETRY_TOL = 1e-3
const SEED_TOL = 1e-6

function maxDelta(a: number[], b: number[]): number {
  if (a.length !== b.length) return Infinity
  return a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0)
}

/**
 * Run the Rust solver on `sketch` and diff against the Python `result`.
 * Geometry is only compared where it is gauge-free: the entity is determinate
 * (Python marks it `fully_constrained`) or Python left it on its seed (then both
 * solvers stay there). Underconstrained-and-moved entities live on a shared
 * constraint manifold where scipy and the hand-rolled LM legitimately differ.
 */
export function compareSketch(
  sketch: SketchInput,
  result: PythonSketchResult,
  solveBytes: SolveBytes,
): ShadowDiff {
  const { input, layout } = lowerSketch(sketch)
  const out = decodeOutput(solveBytes(encodeInput(input)))

  const rustStatus = STATUS_NAME[out.overallStatus]
  const statusMatch = rustStatus === result.status
  const feasible = out.diagnostics.residualNorm < FEASIBLE_TOL

  const geometry = result.geometry ?? {}
  const features = result.features ?? {}
  const entityStatusMismatches: EntityStatusMismatch[] = []
  const geometryMismatches: GeometryMismatch[] = []

  layout.forEach((ent, index) => {
    if (ent.id === ORIGIN_ID) return
    const pyStatus = features[ent.id]?.status
    const pyParams = geometry[ent.id]
    if (!pyStatus || !pyParams) return

    const rustEntityStatus = STATUS_NAME[out.entityStatus[index]]
    if (rustEntityStatus !== pyStatus) {
      entityStatusMismatches.push({ id: ent.id, rust: rustEntityStatus, python: pyStatus })
    }

    const seed = sketch.initial[ent.id] ?? new Array(ent.size).fill(0)
    const determinate = pyStatus === 'fully_constrained' || maxDelta(pyParams, seed) <= SEED_TOL
    if (determinate) {
      const rust = out.paramsSolved.slice(ent.offset, ent.offset + ent.size)
      const delta = maxDelta(rust, pyParams)
      if (delta > GEOMETRY_TOL) {
        geometryMismatches.push({ id: ent.id, rust, python: pyParams, maxDelta: delta })
      }
    }
  })

  const ok =
    statusMatch &&
    feasible &&
    entityStatusMismatches.length === 0 &&
    geometryMismatches.length === 0

  return {
    ok,
    rustStatus,
    pythonStatus: result.status,
    residualNorm: out.diagnostics.residualNorm,
    statusMatch,
    feasible,
    entityStatusMismatches,
    geometryMismatches,
  }
}
