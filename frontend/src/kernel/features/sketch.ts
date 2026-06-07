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
    const loweredEntities = entities.map((ent) => {
      const source = ent.source
      if (!source) return ent
      try {
        const sourceStr = typeof source === 'string' ? source : ''
        if (sourceStr.startsWith('$')) {
          const sourceEid = sourceStr.slice(1)
          const sourceEnt = entities.find((e) => e.id === sourceEid)
          if (sourceEnt && sourceEnt.params) {
            return { ...ent, source: undefined, params: [...(sourceEnt.params as number[])] }
          }
          return ent
        } else {
          const resolved = globalRepo.query(sourceStr, null) as Dict | null
          if (resolved) {
            const data3d = resolve3dGeometry(resolved, sourceStr)
            if (data3d) {
              const kind = (ent.kind as string) ?? 'point'
              const params = projectTo2d(kind, data3d, plane)
              if (params) return { ...ent, source: undefined, params }
            }
          }
        }
      } catch {
        // source resolution failed; entity will keep its source
      }
      return ent
    })

    if (loweredEntities.every((e) => !e.source)) {
      loweredFeature = { ...feature, entities: loweredEntities }
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

function dot3(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function sub3(a: number[], b: number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/** Project a 3D point onto a plane frame, returning [u, v] 2D coordinates. */
function project3dTo2d(xyz: number[], plane: { origin: number[]; x_axis: number[]; y_axis: number[] }): number[] {
  const v = sub3(xyz, plane.origin)
  return [dot3(v, plane.x_axis), dot3(v, plane.y_axis)]
}

interface Resolved3dGeometry {
  kindH: 'point' | 'line' | 'circle' | 'arc'
  data: Dict
}

/** Extract 3D geometry from a repository payload (mirrors `_resolve_source_geometry`). */
function resolve3dGeometry(data: Dict, _sourceQuery: string): Resolved3dGeometry | null {
  const dataType = (data.type as string) ?? ''
  if (dataType === 'face' || dataType === 'flatface' || dataType === 'cylinderface') {
    const pt = data.centroid || data.origin || [0, 0, 0]
    return { kindH: 'point', data: { point: pt } }
  }
  if (dataType === 'edge' || dataType === 'straightedge') {
    const edgeKind = (data.kind as string) ?? ''
    if (edgeKind === 'circle' || edgeKind === 'arc') {
      const center = data.center as number[] | undefined
      const radius = data.radius as number | undefined
      if (!center || radius == null) return null
      if (edgeKind === 'circle') return { kindH: 'circle', data: { center, radius } }
      return {
        kindH: 'arc',
        data: {
          center,
          radius,
          axis: data.axis,
          x_axis: data.x_axis,
          angle_start: data.angle_start,
          angle_end: data.angle_end,
        },
      }
    }
    const start = data.start as number[] | undefined
    const end = data.end as number[] | undefined
    if (!start || !end) return null
    return { kindH: 'line', data: { start, end } }
  }
  if (dataType === 'vertex') {
    const x = (data.x as number) ?? 0
    const y = (data.y as number) ?? 0
    const z = (data.z as number) ?? 0
    return { kindH: 'point', data: { point: [x, y, z] } }
  }
  // Fallback: payloads from the slash registry (hole points, etc.)
  if ('x' in data || 'y' in data || 'z' in data) {
    const x = (data.x as number) ?? 0
    const y = (data.y as number) ?? 0
    const z = (data.z as number) ?? 0
    return { kindH: 'point', data: { point: [x, y, z] } }
  }
  if (data.origin) {
    return { kindH: 'point', data: { point: data.origin as number[] } }
  }
  return null
}

function len2d(v: number[]): number {
  return Math.hypot(v[0], v[1])
}

function atan2(y: number, x: number): number {
  return Math.atan2(y, x)
}

/** Project resolved 3D geometry to entity params on the sketch plane. */
function projectTo2d(
  kind: string,
  g3d: Resolved3dGeometry,
  plane: { origin: number[]; x_axis: number[]; y_axis: number[] },
): number[] | null {
  const { data } = g3d
  if (kind === 'point') {
    const pt = data.point as number[]
    return project3dTo2d(pt, plane)
  }
  if (kind === 'line') {
    const s2d = project3dTo2d(data.start as number[], plane)
    const e2d = project3dTo2d(data.end as number[], plane)
    return [...s2d, ...e2d]
  }
  if (kind === 'circle') {
    const c2d = project3dTo2d(data.center as number[], plane)
    return [...c2d, data.radius as number]
  }
  if (kind === 'arc') {
    const center = data.center as number[]
    const radius = data.radius as number
    const c2d = project3dTo2d(center, plane)

    if (typeof data.angle_start === 'number' && typeof data.angle_end === 'number') {
      // Sketch-to-sketch arc projection (source arc has 2D angles already).
      return [...c2d, radius, data.angle_start as number, data.angle_end as number]
    }

    // 3D body arc: resolve endpoints in 3D, project to 2D, then compute
    // angles relative to the projected center. Mirrors `_project_3d_arc_to_params`.
    const axis = data.axis as number[]
    const ax = data.x_axis as number[]
    const a0 = data.angle_start as number
    const a1 = data.angle_end as number
    if (!axis || !ax || a0 == null || a1 == null) return null

    // orthonormal (x_axis, y_axis) from the arc's 3D frame
    const axNorm = [ax[0], ax[1], ax[2]] as number[]
    const normal = axis
    const y_axis = [
      normal[1] * axNorm[2] - normal[2] * axNorm[1],
      normal[2] * axNorm[0] - normal[0] * axNorm[2],
      normal[0] * axNorm[1] - normal[1] * axNorm[0],
    ]

    const cos0 = Math.cos(a0)
    const sin0 = Math.sin(a0)
    const cos1 = Math.cos(a1)
    const sin1 = Math.sin(a1)
    const start3d = [
      center[0] + radius * (cos0 * axNorm[0] + sin0 * y_axis[0]),
      center[1] + radius * (cos0 * axNorm[1] + sin0 * y_axis[1]),
      center[2] + radius * (cos0 * axNorm[2] + sin0 * y_axis[2]),
    ]
    const end3d = [
      center[0] + radius * (cos1 * axNorm[0] + sin1 * y_axis[0]),
      center[1] + radius * (cos1 * axNorm[1] + sin1 * y_axis[1]),
      center[2] + radius * (cos1 * axNorm[2] + sin1 * y_axis[2]),
    ]

    const s2d = project3dTo2d(start3d, plane)
    const e2d = project3dTo2d(end3d, plane)

    const sa = atan2(s2d[1] - c2d[1], s2d[0] - c2d[0])
    const ea = atan2(e2d[1] - c2d[1], e2d[0] - c2d[0])
    const r2d = len2d([s2d[0] - c2d[0], s2d[1] - c2d[1]])
    return [...c2d, r2d, sa, ea]
  }
  return null
}
