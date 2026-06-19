/**
 * The sketch constraint solver, backed by the Rust WASM kernel
 * (originally ported from the ``_solve_sketch`` / ``_dispatch_sketch`` backend).
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
 * builder's try/catch returns a clean exception (the browser kernel is the only
 * solver; there is no backend fallback).
 *
 * Projected entities and center_rect sugar are not yet lowered; sketches
 * containing them throw a descriptive error.
 */

import type { PartFeature, Sketch, Entity } from '@/types/cad'
import type { Repository } from '../query'
import type { Body } from '../types3d'
import { partDocToSketches } from '@/wasm-kernel/partDocToSketches'
import { lowerSketch, ORIGIN_ID, type EntityLayout } from '@/wasm-kernel/lowerSketch'
import { encodeInput, decodeOutput, STATUS_NAME, type FlatInput } from '@/wasm-kernel/codec'
import { VERTEX_INDICES, ALL_COORD_INDICES } from '@/registry'
import { solveTopology, reconcileMaterializedContacts, type TopologyBytes } from '../topologyDecorate'
import { frameToPlaneTransform, projectWorldToFrame, type Frame3D } from '../types3d'
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
  /** The document origin (0,0,0) expressed in this sketch's local 2D frame.
   *  Both the hard solve and the drag path need the same value so @builtin_origin
   *  constraints pin to the same point. Computed once here, consumed by the drag
   *  path via solveResult.originLocal -- no round-trip recomputation. */
  originLocal?: [number, number]
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
  // Projected entities whose params resolved this solve. Their `source` is
  // stripped so the solver sees ordinary geometry; pinning every one of their
  // params (via the lowered `pinned_mask`) keeps the LM exploration from nudging
  // them off the projected location -- the design invariant "a projected entity
  // is just an entity whose params are pinned".
  const pinnedIds: string[] = []

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
        pinnedIds.push(entId)
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
  // Express the document origin (0,0,0) in this sketch's local 2D frame so a
  // `@builtin_origin` coincident pins to the actual document origin, not the
  // sketch plane's local (0,0) -- which differ for a sketch on an offset/
  // projected face ("line constrained to origin" bug).
  const originLocal = projectWorldToFrame([0, 0, 0], plane as Frame3D)
  const pf = loweredFeature as unknown as PartFeature
  const extract = partDocToSketches([pf], originLocal, pinnedIds)
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
  // Solved positions of materialized point entities, so the topology can lean on
  // them instead of re-emitting an inferred crossing at the same spot (slice 4).
  const pointPositions: [number, number][] = []
  for (let i = 0; i < layout.length; i++) {
    const ent = layout[i]
    const params = out.paramsSolved.slice(ent.offset, ent.offset + ent.size)
    if (ent.id === ORIGIN_ID) continue
    if (Math.abs(params[0]) > 1e-12 || params.length > 1) {
      geometry[ent.id] = [...params]
    }
    features[ent.id] = { status: STATUS_NAME[out.entityStatus[i]] }
    richGeom[ent.id] = enrichSketchEntity(ent.kind, params)
    if (ent.kind === 'point') pointPositions.push([params[0], params[1]])
  }

  // Topology + plane transform: what postRegister registers as _topo_/_pt_ so
  // downstream features can resolve this sketch's profile. A crossing already
  // owned by a materialized point yields to that point's identity.
  const topology = reconcileMaterializedContacts(
    solveTopology(richGeom, featureId, topologyBytes),
    pointPositions,
  )
  const plane_transform = frameToPlaneTransform(plane as Frame3D)

  return {
    status,
    geometry,
    features,
    originLocal,
    topology,
    plane_transform,
    ...(Object.keys(resolvedKinds).length ? { resolved_kinds: resolvedKinds } : {}),
    ...(projectionErrors.length ? { projection_errors: projectionErrors } : {}),
    solve_ms: 0,
  }
}

// ── Drag-solve infrastructure ──────────────────────────────────────────

/** True once the WASM solver is loaded in THIS JS context. The worker and the
 *  main thread each hold their own module instance; the drag path runs on the
 *  main thread and must check its own instance, never assume the worker's. */
export function isSketchSolverReady(): boolean {
  return solverBytes !== null
}

/** Everything one drag needs, lowered once at pointer-down. The per-frame
 *  solve only rewrites `input.params` (warm-start + cursor) and re-encodes;
 *  the entity/constraint lowering is never repeated during the drag. */
export interface DragContext {
  /** Lowered solver input with `dragMode`/`dragAnchorId`/`skipStatusPass`
   *  baked in. Its params are overwritten every frame. */
  input: FlatInput
  layout: EntityLayout[]
  /** Lowered seed params (= feature.initial = the last hard solve, because
   *  applyGeometryToFeature writes solved geometry back into `initial`).
   *  This is the frame-0 warm start. */
  params0: number[]
  /** Flat param indices the cursor position is written to each frame.
   *  For edge/entity drags this is the start of the entity's param block. */
  cursorIndices: [number, number]
  /** True when this is an entity-level (whole-entity translation) drag. */
  isEdgeDrag: boolean
  /** Param offset of the dragged entity in the flat array. */
  entityParamOffset: number
  /** All [xIndex, yIndex] coordinate pair offsets within the entity's param block. */
  entityCoordPairs: [number, number][]
  /** Set for an arc start/end drag. The endpoint is derived (center + radius at
   *  an angle), not a direct param pair, so the cursor XY must be mapped into
   *  the arc's radius and angle params each frame instead of written directly. */
  arcEndpoint?: {
    centerIndices: [number, number]
    radiusIndex: number
    angleIndex: number
  }
}

/**
 * Build the drag context for one drag, straight from the feature definition.
 * Runs on the main thread with no Repository and no prior in-process hard
 * solve: the last hard solve's geometry is already in `feature.initial`.
 *
 * Projected entities (carrying a `source` query) cannot be re-resolved here;
 * their last resolved params are also in `initial`, so the source is stripped
 * and the params reused. A projected entity with no params yet is dropped,
 * mirroring solveSketch's projection_errors path (constraints referencing it
 * are dropped by partDocToSketches).
 *
 * For vertex drags, `dragVertexKey` is the specific vertex being dragged
 * (e.g. 'start', 'end', 'center'). For edge/entity drags (whole-entity
 * translation), pass `dragVertexKey = null`.
 *
 * Returns null when the feature does not lower, the dragged entity is not in
 * the layout, or the vertex has no direct param mapping (caller shows the
 * static sketch or a simple translation preview).
 */
export function prepareDragContext(
  feature: PartFeature,
  dragEntityId: string,
  dragVertexKey: string | null,
  originLocal: [number, number] = [0, 0],
): DragContext | null {
  try {
    const entities = feature.entities ?? []
    let loweredFeature = feature
    // Projected entities kept this drag (their last resolved params survive in
    // `initial`); pinned in the lowered solve so a drag preview never unsticks
    // them, mirroring the hard solve (solveSketch).
    const pinnedIds: string[] = []
    if (entities.some((e) => e.source)) {
      const initial = feature.initial ?? {}
      const kept: typeof entities = []
      for (const ent of entities) {
        if (!ent.source) { kept.push(ent); continue }
        if (initial[ent.id]) { kept.push({ ...ent, source: undefined }); pinnedIds.push(ent.id) }
      }
      loweredFeature = { ...feature, entities: kept }
    }

    // originLocal expresses the document origin (0,0,0) in this sketch's local
    // 2D frame so a `@builtin_origin` coincident pins to the actual document
    // origin during the drag preview -- not the plane's local (0,0), which
    // differ for a sketch on an offset/projected face. The hard solve already
    // does this (solveSketch); without it here the dragged geometry pins to the
    // wrong point and visibly snaps back on release.
    const extract = partDocToSketches([loweredFeature], originLocal, pinnedIds)
    if (extract.skipped.length || !extract.sketches.length) return null

    const { input, layout } = lowerSketch(extract.sketches[0].sketch)

    const anchorIndex = layout.findIndex((l) => l.id === dragEntityId)
    if (anchorIndex === -1) return null
    const ent = layout[anchorIndex]

    const isEdge = dragVertexKey === null
    if (!isEdge) {
      const vi = VERTEX_INDICES[ent.kind]?.[dragVertexKey]
      if (vi) {
        // The doc param layout and the lowered layout share per-kind ordering, so
        // the registry indices apply directly at the entity's offset.
        input.options = { dragMode: true, dragAnchorId: anchorIndex, skipStatusPass: true }
        return {
          input,
          layout,
          params0: [...input.params],
          cursorIndices: [ent.offset + vi[0], ent.offset + vi[1]],
          isEdgeDrag: false,
          entityParamOffset: ent.offset,
          entityCoordPairs: [],
        }
      }
      // Arc start/end are derived from center + radius + angle, so they have no
      // direct param pair in VERTEX_INDICES. Pin them via radius/angle instead
      // (params: [cx, cy, radius, angle_start, angle_end]).
      if (ent.kind === 'arc' && (dragVertexKey === 'start' || dragVertexKey === 'end')) {
        const angleIndex = ent.offset + (dragVertexKey === 'start' ? 3 : 4)
        input.options = { dragMode: true, dragAnchorId: anchorIndex, skipStatusPass: true }
        return {
          input,
          layout,
          params0: [...input.params],
          cursorIndices: [ent.offset + 2, angleIndex],
          isEdgeDrag: false,
          entityParamOffset: ent.offset,
          entityCoordPairs: [],
          arcEndpoint: {
            centerIndices: [ent.offset, ent.offset + 1],
            radiusIndex: ent.offset + 2,
            angleIndex,
          },
        }
      }
      return null
    }

    // Edge/entity drag: whole-entity translation. The anchor entity's ALL
    // params get REG_WEIGHT_DRAG (Rust solve.rs) to bias it toward the
    // translated position. Each solve frame applies the cursor delta to every
    // coordinate pair, then lets the solver resolve constraints on other
    // entities.
    const coordPairs = ALL_COORD_INDICES[ent.kind]
    if (!coordPairs) return null
    input.options = { dragMode: true, dragAnchorId: anchorIndex, skipStatusPass: true }
    return {
      input,
      layout,
      params0: [...input.params],
      cursorIndices: [ent.offset, ent.offset + 1],
      isEdgeDrag: true,
      entityParamOffset: ent.offset,
      entityCoordPairs: coordPairs as [number, number][],
    }
  } catch {
    return null
  }
}

/** Rebuild a Sketch (for Geometry3D rendering) and a per-entity geometry map
 *  (the pointer-up commit payload) from flattened solver params + layout. */
export function paramsToPreview(
  params: number[],
  layout: EntityLayout[],
): { sketch: Sketch; geometry: Record<string, number[]> } {
  const sketch: Record<string, Entity> = {}
  const geometry: Record<string, number[]> = {}
  for (const ent of layout) {
    if (ent.id === ORIGIN_ID) continue
    const p = params.slice(ent.offset, ent.offset + ent.size)
    geometry[ent.id] = p
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
  return { sketch, geometry }
}

export interface DragSolveResult {
  /** Reconstructed Sketch for Geometry3D preview rendering. */
  sketch: Sketch
  /** Per-entity solved params; carried into the pointer-up commit so the hard
   *  solve seeds from the on-screen state (no basin jump on release). */
  geometry: Record<string, number[]>
  /** Solved params (becomes the next frame's warm-start seed). */
  params: number[]
  /** Solver status string. */
  status: string
}

/**
 * Run a single drag-frame WASM solve against a prepared context. Writes the
 * warm-start params + cursor into the context's input and solves; mutates
 * nothing else (not the PartDoc, not the Repository, not the feature).
 *
 * For vertex drags, `cursorWorld` pins the dragged vertex.
 * For edge/entity drags, `edgeDelta` (cursor delta from drag start) translates
 * every coordinate pair of the dragged entity before solving — each frame
 * seeds from the original params0 plus the delta.
 *
 * Returns null when the solver is not loaded in this context or the solve
 * throws (caller holds the last good preview).
 */
export function solveSketchDrag(
  ctx: DragContext,
  warmStartParams: number[],
  cursorWorld: [number, number],
  edgeDelta?: [number, number],
): DragSolveResult | null {
  if (!solverBytes) return null

  const { input, layout, cursorIndices } = ctx

  if (ctx.isEdgeDrag && edgeDelta) {
    // Edge/entity drag: each frame seeds from params0 (the last hard solve)
    // and translates the dragged entity's coordinate pairs by the cursor
    // delta. Starting fresh from params0 every frame avoids warm-start drift;
    // the solver's REG_WEIGHT_DRAG on the anchor entity keeps it near the
    // translated position while hard constraints resolve on all entities.
    const n = input.params.length
    for (let i = 0; i < n; i++) {
      input.params[i] = ctx.params0[i]
    }
    const offset = ctx.entityParamOffset
    for (const [xi, yi] of ctx.entityCoordPairs) {
      input.params[offset + xi] += edgeDelta[0]
      input.params[offset + yi] += edgeDelta[1]
    }
  } else {
    // Vertex drag: warm-start from the previous frame, then pin the dragged
    // vertex to the cursor position. The firm REG_WEIGHT_DRAG on the anchor
    // entity's params (Rust solve.rs) keeps the vertex near the cursor while
    // constraints resolve.
    const n = Math.min(input.params.length, warmStartParams.length)
    for (let i = 0; i < n; i++) {
      input.params[i] = warmStartParams[i]
    }
    if (ctx.arcEndpoint) {
      // Map the cursor XY into the arc's radius and angle. The center comes from
      // the warm start (REG_WEIGHT_DRAG biases it to stay put unless constraints
      // move it), so radius = |cursor - center| and angle points at the cursor;
      // the endpoint then lands on the cursor.
      const { centerIndices, radiusIndex, angleIndex } = ctx.arcEndpoint
      const dx = cursorWorld[0] - input.params[centerIndices[0]]
      const dy = cursorWorld[1] - input.params[centerIndices[1]]
      input.params[radiusIndex] = Math.hypot(dx, dy)
      // Keep the angle on the warm-start branch (atan2 wraps at +/-180) so a
      // crossing of the seam does not flip the arc by a full turn.
      const prev = input.params[angleIndex]
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI
      ang += Math.round((prev - ang) / 360) * 360
      input.params[angleIndex] = ang
    } else {
      input.params[cursorIndices[0]] = cursorWorld[0]
      input.params[cursorIndices[1]] = cursorWorld[1]
    }
  }

  let out
  try {
    out = decodeOutput(solverBytes(encodeInput(input)))
  } catch {
    return null
  }

  const status = STATUS_NAME[out.overallStatus]
  const { sketch, geometry } = paramsToPreview(out.paramsSolved, layout)
  return { sketch, geometry, params: out.paramsSolved, status }
}
