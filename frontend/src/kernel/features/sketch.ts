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

import type { PartFeature, Sketch, Entity } from '@/types/cad'
import type { Repository } from '../query'
import type { Body } from '../types3d'
import { partDocToSketches } from '@/wasm-kernel/partDocToSketches'
import { lowerSketch, ORIGIN_ID, type LowerOptions, type SketchInput, type EntityLayout } from '@/wasm-kernel/lowerSketch'
import { encodeInput, decodeOutput, STATUS_NAME } from '@/wasm-kernel/codec'
import { solveTopology, type TopologyBytes } from '../topologyDecorate'
import { frameToPlaneTransform, type Frame3D } from '../types3d'
import { resolveSketchPlane, enrichSketchEntity } from './postRegister'
import { loadSolverWasm, loadTopologyWasm } from '@/wasm-kernel/solverWasm'
import { resolve3dGeometry, projectTo2d, type PlaneFrame } from './projectionLowering'
import type { SolveBytes } from '@/wasm-kernel/codec'

type Dict = Record<string, unknown>

export interface SketchResult {
  [key: string]: unknown
  status: string
  geometry?: Record<string, number[]>
  features?: Record<string, { status: string }>
  /** For projected entities whose lowered kind differs from the kind declared
   *  at pick time (tilted circle -> ellipse, partial ellipse -> spline): the
   *  resolved kind, so the doc entity can adopt it and its params stay matched. */
  resolved_kinds?: Record<string, string>
  /** Entity ids of projected entities whose source query could not be resolved
   *  this solve; they were dropped so the rest of the sketch could build. */
  projection_errors?: string[]
}

let solverBytes: SolveBytes | null = null
let solverLoading: Promise<SolveBytes | null> | null = null
// The Rust area builder (`detect_topology_bytes`). The browser wires it in
// `initSketchSolver` (awaited alongside the solver); the node harness injects it
// via `setSketchTopology`. Only null on a fresh checkout with no `just wasm`, in
// which case the missing solver makes `solveSketch` throw first.
let topologyBytes: TopologyBytes | null = null

/** Inject a pre-loaded solver (node tests call this with ``loadSolver()``). */
export function setSketchSolver(bytes: SolveBytes | null): void {
  solverBytes = bytes
  solverLoading = null
}

/** Inject a pre-loaded Rust area builder; null restores the TS fallback. */
export function setSketchTopology(bytes: TopologyBytes | null): void {
  topologyBytes = bytes
}

/** Start loading the Rust solver + area builder from ``/wasm/`` (browser path). */
export async function initSketchSolver(): Promise<SolveBytes | null> {
  if (solverBytes) return solverBytes
  if (!solverLoading) {
    // Wire the area builder alongside the solver (they share one wasm module) and
    // AWAIT both, so the first synchronous solve never races a half-loaded
    // topology. A null topology loader (mock / fresh checkout) leaves any
    // already-injected loader in place.
    let topoLoad: Promise<TopologyBytes | null>
    try {
      topoLoad = loadTopologyWasm?.() ?? Promise.resolve(null)
    } catch {
      topoLoad = Promise.resolve(null)
    }
    solverLoading = Promise.all([loadSolverWasm(), topoLoad.catch(() => null)]).then(([b, t]) => {
      solverBytes = b
      if (t) topologyBytes = t
      return b
    })
  }
  return solverLoading
}

/** Clear the cached solver (tests). The area builder loader is environment
 *  stable (not per-test state), so it is intentionally preserved across a
 *  solver reset; use `setSketchTopology(null)` to drop it explicitly. */
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
  // Projected entities whose lowered kind differs from the declared kind; the
  // caller adopts these onto the doc entity so its params stay matched.
  const resolvedKinds: Record<string, string> = {}
  // Projected entities whose source query could not be resolved this solve
  // (e.g. a stale ancestry query after the source B-rep changed). They are
  // dropped from the solve so the rest of the sketch still builds.
  const projectionErrors: string[] = []

  if (hasProjections && entities.length > 0) {
    // Resolved params land in `initial` (keyed by entity id) -- the same place
    // lowerSketch reads seed params from. The source query is re-resolved on
    // every solve, so projected geometry tracks the source B-rep (parametric
    // associativity); a projected entity carries no params in the doc itself.
    const initial: Record<string, number[]> = { ...((feature.initial as Record<string, number[]>) ?? {}) }
    const loweredEntities: Array<Dict> = []
    for (const ent of entities) {
      const source = ent.source
      if (!source) { loweredEntities.push(ent); continue }
      const entId = ent.id as string
      let lowered: Dict | null = null
      try {
        const sourceStr = typeof source === 'string' ? source : ''
        if (sourceStr.startsWith('$')) {
          const sourceEid = sourceStr.slice(1)
          const srcParams = initial[sourceEid]
          if (srcParams) {
            initial[entId] = [...srcParams]
            lowered = { ...ent, source: undefined }
          }
        } else {
          const resolved = globalRepo.query(sourceStr, null) as Dict | null
          if (resolved) {
            const data3d = resolve3dGeometry(resolved, sourceStr)
            if (data3d) {
              const declaredKind = (ent.kind as string) ?? 'point'
              const projected = projectTo2d(data3d, plane as PlaneFrame)
              if (projected) {
                initial[entId] = projected.params
                // A tilted circle lowers to an ellipse, a partial ellipse to a
                // spline: the resolved kind wins, and is surfaced so the doc
                // entity adopts it (its param count must match the geometry).
                if (projected.kind !== declaredKind) resolvedKinds[entId] = projected.kind
                lowered = { ...ent, source: undefined, kind: projected.kind }
              }
            }
          }
        }
      } catch {
        // fall through to the unresolved path below
      }
      if (lowered) {
        loweredEntities.push(lowered)
      } else {
        // Unresolvable projection: drop it rather than leaving a `source` that
        // would make partDocToSketches skip (and the whole sketch throw). The
        // rest of the sketch -- including the user's own geometry -- still solves.
        projectionErrors.push(entId)
      }
    }

    loweredFeature = { ...feature, entities: loweredEntities, initial }
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
  dragInputCache.set(featureId, { sketch, layout: null as unknown as EntityLayout[], plane: plane as Frame3D | null, feature: loweredFeature as unknown as PartFeature, lastHardSolveParams: [] })
  const { input, layout } = lowerSketch(sketch)
  const out = decodeOutput(solverBytes(encodeInput(input)))
  dragInputCache.set(featureId, { sketch, layout, plane: plane as Frame3D | null, feature: loweredFeature as unknown as PartFeature, lastHardSolveParams: [...out.paramsSolved] })
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
  const topology = solveTopology(richGeom, featureId, topologyBytes)
  const plane_transform = frameToPlaneTransform(plane as Frame3D)

  return {
    status,
    geometry,
    features,
    topology,
    plane_transform,
    ...(Object.keys(resolvedKinds).length ? { resolved_kinds: resolvedKinds } : {}),
    ...(projectionErrors.length ? { projection_errors: projectionErrors } : {}),
    solve_ms: 0,
  }
}

// ── Drag-solve infrastructure ──────────────────────────────────────────

/** Cached lowering context for drag-frame WASM solves. Keyed by feature id.
 *  Populated by solveSketch on every hard solve; read by solveSketchDrag. */
export interface DragCacheEntry {
  sketch: SketchInput
  layout: EntityLayout[]
  plane: Frame3D | null
  feature: PartFeature
  /** The last hard-solve params (flat array); seed for frame-0 warm-start. */
  lastHardSolveParams: number[]
}
const dragInputCache = new Map<string, DragCacheEntry>()

/** Get the cached lowering context for a feature. Returns null on cache miss
 *  (no hard solve has been done yet, or the feature is not a sketch). */
export function getDragCache(featureId: string): DragCacheEntry | null {
  return dragInputCache.get(featureId) ?? null
}

/** Seed the drag cache for tests that call solveSketchDrag directly. */
export function setDragCacheForTest(featureId: string, entry: DragCacheEntry): void {
  dragInputCache.set(featureId, entry)
}

/** Map a vertex key to the param indices within an entity's param block.
 *  Returns the flat-array indices where the cursor position should be
 *  written during a drag frame. Returns null for derived vertices
 *  (arc start/end, ellipse major/minor, spline c1/c2) that cannot be
 *  overwritten via direct param write. */
function vertexParamIndices(kind: string, offset: number, vertexKey: string): number[] | null {
  switch (kind) {
    case 'line':
      if (vertexKey === 'start') return [offset, offset + 1]
      if (vertexKey === 'end') return [offset + 2, offset + 3]
      return null
    case 'circle':
      if (vertexKey === 'center') return [offset, offset + 1]
      return null
    case 'arc':
      if (vertexKey === 'center') return [offset, offset + 1]
      // start/end are derived from angle params
      return null
    case 'point':
      if (vertexKey === 'xy') return [offset, offset + 1]
      return null
    case 'ellipse':
      if (vertexKey === 'center') return [offset, offset + 1]
      // major1/major2/minor1/minor2 are derived
      return null
    case 'spline':
      // p0=[offset..offset+1], p1=[offset+2..offset+3], p2=[offset+4..offset+5], p3=[offset+6..offset+7]
      // But vertexKey for spline is set via Sel codes not plain start/end – skip for now
      return null
    default:
      return null
  }
}

/** Rebuild a Sketch from flattened solver params + entity layout.
 *  The output matches what Geometry3D expects for rendering. */
function paramsToPreview(params: number[], layout: EntityLayout[]): Sketch {
  const sketch: Record<string, Entity> = {}
  for (const ent of layout) {
    if (ent.id === ORIGIN_ID) continue
    const p = params.slice(ent.offset, ent.offset + ent.size)
    switch (ent.kind) {
      case 'line':
        sketch[ent.id] = { start: [p[0], p[1]], end: [p[2], p[3]] } as Entity
        break
      case 'circle':
        sketch[ent.id] = { center: [p[0], p[1]], radius: p[2] } as Entity
        break
      case 'arc': {
        const cx = p[0], cy = p[1], r = p[2], a0 = p[3], a1 = p[4]
        const a0r = a0 * Math.PI / 180, a1r = a1 * Math.PI / 180
        sketch[ent.id] = {
          center: [cx, cy], radius: r,
          angle_start: a0, angle_end: a1,
          start: [cx + r * Math.cos(a0r), cy + r * Math.sin(a0r)],
          end: [cx + r * Math.cos(a1r), cy + r * Math.sin(a1r)],
        } as Entity
        break
      }
      case 'point':
        sketch[ent.id] = { x: p[0], y: p[1] } as Entity
        break
      case 'ellipse':
        sketch[ent.id] = { center: [p[0], p[1]], a: p[2], b: p[3], theta: p[4] } as Entity
        break
      case 'spline':
        sketch[ent.id] = { p1: [p[0], p[1]], p2: [p[2], p[3]], p3: [p[4], p[5]], p4: [p[6], p[7]] } as Entity
        break
    }
  }
  return sketch
}

export interface DragSolveResult {
  /** Reconstructed Sketch for Geometry3D preview rendering. */
  sketch: Sketch
  /** Solved params (becomes the next frame's warm-start seed). */
  params: number[]
  /** Solver status string. */
  status: string
}

/**
 * Run a single drag-frame WASM solve. Always reads the lowering context from the
 * cache (populated by the last hard solve). Uses warm-start params + cursor
 * overwrite + drag options. Does NOT mutate the PartDoc or the Repository.
 *
 * Returns null when the drag cache is empty (hard solve never ran), the solver
 * is not loaded, or the dragged vertex has no direct param indices.
 */
export function solveSketchDrag(
  featureId: string,
  warmStartParams: number[],
  dragEntityId: string,
  dragVertexKey: string,
  cursorWorld: [number, number],
): DragSolveResult | null {
  if (!solverBytes) return null

  const cache = dragInputCache.get(featureId)
  if (!cache) return null

  const { sketch: sketchInput, layout } = cache
  const dragEntityIndex = layout.findIndex((l) => l.id === dragEntityId)
  if (dragEntityIndex === -1) return null

  const dragEnt = layout[dragEntityIndex]
  const indices = vertexParamIndices(dragEnt.kind, dragEnt.offset, dragVertexKey)
  if (!indices) return null

  const opts: LowerOptions = {
    dragMode: true,
    dragAnchorId: dragEntityIndex,
    skipStatusPass: true,
  }
  const { input } = lowerSketch(sketchInput, opts)

  // Overwrite params with warm-start seed, then pin the dragged vertex to
  // the cursor position. The firm REG_WEIGHT_DRAG on the anchor entity's
  // params (Rust solve.rs) keeps the vertex near the cursor while constraints
  // resolve.
  for (let i = 0; i < input.params.length && i < warmStartParams.length; i++) {
    input.params[i] = warmStartParams[i]
  }
  input.params[indices[0]] = cursorWorld[0]
  input.params[indices[1]] = cursorWorld[1]

  let out
  try {
    out = decodeOutput(solverBytes(encodeInput(input)))
  } catch {
    return null
  }

  const status = STATUS_NAME[out.overallStatus]
  const preview = paramsToPreview(out.paramsSolved, layout)
  return { sketch: preview, params: out.paramsSolved, status }
}
