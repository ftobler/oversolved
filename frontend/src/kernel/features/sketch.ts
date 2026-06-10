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
import { lowerSketch, ORIGIN_ID } from '@/wasm-kernel/lowerSketch'
import { encodeInput, decodeOutput, STATUS_NAME } from '@/wasm-kernel/codec'
import { detectTopology } from '../topology'
import { frameToPlaneTransform, type Frame3D } from '../types3d'
import { resolveSketchPlane, enrichSketchEntity } from './postRegister'
import { loadSolverWasm } from '@/wasm-kernel/solverWasm'
import { resolve3dGeometry, projectTo2d, type PlaneFrame } from './projectionLowering'
import type { SolveBytes } from '@/wasm-kernel/codec'

type Dict = Record<string, unknown>

export interface SketchResult {
  [key: string]: unknown
  status: string
  geometry?: Record<string, number[]>
  features?: Record<string, { status: string }>
}

let solverBytes: SolveBytes | null = null
let solverLoading: Promise<SolveBytes | null> | null = null

/** Inject a pre-loaded solver (node tests call this with ``loadSolver()``). */
export function setSketchSolver(bytes: SolveBytes | null): void {
  solverBytes = bytes
  solverLoading = null
}

/** Start loading the Rust solver from ``/wasm/`` (browser path). */
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
 *
 * Projected entities (those carrying a ``source`` ancestry query) are lowered
 * here before the Rust solver sees them: the source geometry is resolved via
 * the repository, projected onto the sketch plane, and the resulting 2D params
 * replace the entity's initial values. The entity is then marked as pinned so
 * the solver treats it as immovable. This mirrors Python's
 * ``_project_source_to_params`` + ``_resolve_source_geometry``.
 */
export function solveSketch(
  feature: Dict,
  globalRepo: Repository,
  _bodyStore: Record<string, Body>,
): SketchResult {
  if (!solverBytes) {
    throw new Error('sketch: Rust solver not initialised (call initSketchSolver first)')
  }

  const featureId = (feature.id as string) ?? ''

  // ── Lower projected entities before partDocToSketches ──────────────────
  const plane = resolveSketchPlane((feature.plane as string | undefined) ?? null, globalRepo)
  const entities = (feature.entities as Array<Dict>) ?? []
  const hasProjections = entities.some((e) => e.source)
  let loweredFeature = feature

  if (hasProjections && entities.length > 0) {
    // Resolved params land in `initial` (keyed by entity id) -- the same place
    // lowerSketch reads seed params from. The source query is re-resolved on
    // every solve, so projected geometry tracks the source B-rep (parametric
    // associativity); a projected entity carries no params in the doc itself.
    const initial: Record<string, number[]> = { ...((feature.initial as Record<string, number[]>) ?? {}) }
    const loweredEntities = entities.map((ent) => {
      const source = ent.source
      if (!source) return ent
      const entId = ent.id as string
      try {
        const sourceStr = typeof source === 'string' ? source : ''
        if (sourceStr.startsWith('$')) {
          const sourceEid = sourceStr.slice(1)
          const srcParams = initial[sourceEid]
          if (srcParams) {
            initial[entId] = [...srcParams]
            return { ...ent, source: undefined }
          }
          return ent
        } else {
          const resolved = globalRepo.query(sourceStr, null) as Dict | null
          if (resolved) {
            const data3d = resolve3dGeometry(resolved, sourceStr)
            if (data3d) {
              const declaredKind = (ent.kind as string) ?? 'point'
              const projected = projectTo2d(declaredKind, data3d, plane as PlaneFrame)
              if (projected) {
                initial[entId] = projected.params
                // A tilted circle lowers to an ellipse: the resolved kind wins.
                return { ...ent, source: undefined, kind: projected.kind }
              }
            }
          }
        }
      } catch {
        // source resolution failed; entity will keep its source
      }
      return ent
    })

    if (loweredEntities.every((e) => !e.source)) {
      loweredFeature = { ...feature, entities: loweredEntities, initial }
    }
  }

  // ── Lower the live PartDoc feature to SketchInput ──────────────────────
  const pf = loweredFeature as unknown as PartFeature
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

  // Reconstruct per-entity geometry and status maps, plus rich geometry for
  // topology detection (port of _geometry_from_array).
  const geometry: Record<string, number[]> = {}
  const features: Record<string, { status: string }> = {}
  const richGeom: Record<string, Record<string, unknown>> = {}
  for (let i = 0; i < layout.length; i++) {
    const ent = layout[i]
    const params = out.paramsSolved.slice(ent.offset, ent.offset + ent.size)
    if (ent.id === ORIGIN_ID) continue
    if (Math.abs(params[0]) > 1e-12 || params.length > 1) {
      geometry[ent.id] = [...params]
    }
    features[ent.id] = { status: STATUS_NAME[out.entityStatus[i]] }
    richGeom[ent.id] = enrichSketchEntity(ent.kind, params)
  }

  // Topology + plane transform: what postRegister registers as _topo_/_pt_ so
  // downstream features can resolve this sketch's profile.
  const topology = detectTopology(richGeom, featureId)
  const plane_transform = frameToPlaneTransform(plane as Frame3D)

  return {
    status,
    geometry,
    features,
    topology,
    plane_transform,
    solve_ms: 0,
  }
}
