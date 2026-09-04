// The sweep leaf. It resolves the profile to 2D loops (face profiles are not supported for
// sweep), resolves the path reference to an ordered chain of world-space spine edges, sweeps
// the profile's outer boundary along the spine with per-entity lineage, and applies the body
// operation. Includes the path-collection helpers (_path_ref_to_sketch_id,
// _order_edges_into_chain, _collect_path_edges). Spine arcs are built from their exact in-plane
// angle data (spineArcEdge), chain-forward, with the joints snapped so the wire assembles
// regardless of solver-level endpoint precision.

import type { DisposeScope } from '../occ/disposeScope'
import { extractErrorMessage } from '../errors'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { parseAncestry } from '../query'
import { collectExtrudeLoops } from './faceProfile'
import { sketchToWorld2d, extractProfileLoops, parseSketchEntityRef, surfaceEntityIds, type PlaneLike } from './shared'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import { sweepProfileWithLineage } from '../occ/prismLineage'
import { makeLineEdge, makeArcEdge, type Vec3 } from '../occ/primitives'

type Dict = Record<string, unknown>
type Lineage = Record<string, string[]>

/** Resolve a sweep path reference to the sketch id holding the spine. */
export function pathRefToSketchId(pathRef: string, globalRepo: Repository): string {
  if (pathRef.startsWith('@')) return pathRef.slice(1).split('/')[0]
  if (pathRef.startsWith('?')) {
    const [ids] = parseAncestry(pathRef)
    for (const aid of ids) {
      if (aid.startsWith('@') && !aid.includes('/')) {
        const cand = aid.slice(1)
        if (
          globalRepo.elements.get('_topo_' + cand) !== undefined ||
          globalRepo.elements.get('_pt_' + cand) !== undefined
        ) {
          return cand
        }
      }
    }
    throw new Error(`sweep: could not resolve path sketch from ${JSON.stringify(pathRef)}`)
  }
  return pathRef.replace(/^\$+/, '')
}

/**
 * Ordered-edge descriptor: the edge data plus whether it was walked backward
 * (its `end` matched the current chain endpoint, so the walk continued from
 * its `start`).  Callers use `reversed` to build the OCC edge from end→start
 * so the wire's natural forward direction follows the chain without reversing
 * edges later, avoiding arc-direction ambiguity.
 */
export type ChainEdge = { edge: Dict; reversed: boolean }

/**
 * Order path edges into a connected chain, returning each edge plus a
 * `reversed` flag when it was traversed end→start during the walk.
 * The chain always starts from a degree-1 endpoint and walks forward.
 * See [[orderEdgesIntoChain]] for the flag-less original.
 */
export function orderEdgesIntoChain(edges: Dict[], tol = 1e-6): ChainEdge[] {
  const close = (a: number[], b: number[]): boolean => {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) >= tol) return false
    }
    return true
  }

  if (edges.length <= 1) return edges.map((e) => ({ edge: e, reversed: false }))

  const endpoints: number[][] = []
  for (const e of edges) {
    endpoints.push(e.start as number[])
    endpoints.push(e.end as number[])
  }
  const degree = (p: number[]): number => endpoints.filter((q) => close(p, q)).length

  const used = new Array(edges.length).fill(false)
  let startI = 0
  let curPt = edges[0].end as number[]
  let startReversed = false
  for (let i = 0; i < edges.length; i++) {
    if (degree(edges[i].start as number[]) === 1) {
      startI = i
      curPt = edges[i].end as number[]
      startReversed = false
      break
    }
    if (degree(edges[i].end as number[]) === 1) {
      startI = i
      curPt = edges[i].start as number[]
      startReversed = true
      break
    }
  }

  const ordered: ChainEdge[] = [{ edge: edges[startI], reversed: startReversed }]
  used[startI] = true
  for (let k = 0; k < edges.length - 1; k++) {
    let found = false
    for (let j = 0; j < edges.length; j++) {
      if (used[j]) continue
      const e = edges[j]
      if (close(e.start as number[], curPt)) {
        ordered.push({ edge: e, reversed: false })
        used[j] = true
        curPt = e.end as number[]
        found = true
        break
      }
      if (close(e.end as number[], curPt)) {
        ordered.push({ edge: e, reversed: true })
        used[j] = true
        curPt = e.start as number[]
        found = true
        break
      }
    }
    if (!found) throw new Error('sweep: path edges do not form a connected chain')
  }
  return ordered
}

/**
 * Split a sketch-entity selection ref (`entity:<sketchId>:<eid>` or
 * `vertex:<sketchId>:<eid>:<sub>`) into its sketch id and entity id. Returns a
 * null `eid` for a ref that names a whole sketch (`$sk`, `@sk/...`, `?...`);
 * a selection id missing its entity segment names neither, and falls through to
 * `pathRefToSketchId`, which refuses it.
 */
function refToSketchAndEntity(ref: string, globalRepo: Repository): { sketchId: string; eid: string | null } {
  const picked = parseSketchEntityRef(ref)
  if (picked !== null) return picked
  return { sketchId: pathRefToSketchId(ref, globalRepo), eid: null }
}

/**
 * Collect the world-space topo edges a single path ref contributes. An
 * `entity:`/`vertex:` ref selects only the edges of that one sketch entity
 * (edge-precise); any other ref selects every edge of the sketch. Edges carry
 * their world-space start/end (and center for arcs) so a path spanning sketches
 * on different planes orders correctly. Returns [worldEdges, sketchId].
 */
function pathRefWorldEdges(ref: string, globalRepo: Repository): [Dict[], string] {
  const { sketchId, eid } = refToSketchAndEntity(ref, globalRepo)
  const plane = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
  if (plane === undefined) throw new Error(`sweep: path sketch not found: ${JSON.stringify(sketchId)}`)
  const topo = (globalRepo.elements.get('_topo_' + sketchId) as Dict | undefined) ?? {}
  const rawEdges = (topo.edges as Dict[]) ?? []
  const selected = eid === null ? rawEdges : rawEdges.filter((e) => e.entity_id === eid)

  const worldEdges: Dict[] = []
  for (const e of selected) {
    const we: Dict = {
      kind: e.kind,
      edge_index: e.edge_index,
      start: sketchToWorld2d(e.start as number[], plane),
      end: sketchToWorld2d(e.end as number[], plane),
    }
    if (e.kind === 'arc' && 'center' in e) {
      we.center = sketchToWorld2d(e.center as number[], plane)
      we.radius = Number(e.radius)
      // Carry the EXACT in-plane arc descriptor (sketch-2D center + stored
      // angle span + ccw) and its plane. spineArcEdge builds the arc with its
      // circle axis locked to the exact plane normal, so shallow / near-180
      // arcs stay in plane (reconstructing the plane from world endpoints is
      // ill-conditioned and tilts the arc). The stored angles also fix the
      // arc SIDE without guessing minor vs major from the endpoints.
      we._plane = plane
      we._arc = {
        center: e.center as number[],  // 2D sketch coords (mapped via plane)
        radius: Number(e.radius),
        angle_start_deg: Number(e.angle_start_deg),
        angle_end_deg: Number(e.angle_end_deg),
        ccw: (e.ccw as boolean) ?? true,
      }
    }
    worldEdges.push(we)
  }
  return [worldEdges, sketchId]
}

/**
 * Gather one or more sweep path references into a single ordered chain of
 * world-space edge descriptors (the OCC-free core of `_collect_path_edges`,
 * extended for multi-pick / edge-precise selection). Edges shared between refs
 * are deduped, and the whole set must form one connected chain. Returns
 * [orderedWorldEdges, firstPathSketchId].
 */
export function orderedPathWorldEdges(
  pathRefs: string | string[],
  globalRepo: Repository,
): [ChainEdge[], string] {
  const refs = Array.isArray(pathRefs) ? pathRefs : [pathRefs]
  const worldEdges: Dict[] = []
  const seen = new Set<string>()  // dedupe edges shared between refs (sketch + index)
  let firstSketchId = ''
  for (const ref of refs) {
    const [edges, sketchId] = pathRefWorldEdges(ref, globalRepo)
    if (!firstSketchId) firstSketchId = sketchId
    for (const e of edges) {
      const key = sketchId + ':' + String(e.edge_index)
      if (seen.has(key)) continue
      seen.add(key)
      worldEdges.push(e)
    }
  }
  if (worldEdges.length === 0) throw new Error('sweep: path has no edges')
  return [orderEdgesIntoChain(worldEdges), firstSketchId]
}

/** The 2D in-plane descriptor of a spine arc, carried from topology. */
type ArcParams = {
  center: number[]
  radius: number
  angle_start_deg: number
  angle_end_deg: number
  ccw: boolean
}

/**
 * Build a spine arc edge running in the CHAIN-FORWARD direction (s -> t) over
 * the correct side of the circle.
 *
 * This is deliberately NOT buildArcEdge (the profile arc builder). A profile
 * arc lands in a face whose orientation ShapeFix_Face later normalizes, so its
 * edge direction is free. A SPINE wire's direction IS the sweep path: the
 * profile is carried from the wire's first vertex to its last, so each edge
 * must point the way the chain walks. Lines already do (makeLineEdge(s, t));
 * arcs must too, or the second segment sweeps backward and the solid comes out
 * the wrong shape (or collapses to the profile face).
 *
 * The circle axis is locked to the EXACT plane normal: shallow / near-180 arcs
 * stay in plane instead of tilting (the old world-point reconstruction derived
 * the axis from a cross product that degenerates as the span shrinks). The
 * stored angle span fixes the arc SIDE, so there is no minor/major guessing.
 */
function spineArcEdge(
  oc: OccModule,
  scope: DisposeScope,
  plane: PlaneLike,
  arc: ArcParams,
  reversed: boolean,
): OccShape {
  const center3d = sketchToWorld2d(arc.center, plane) as Vec3
  const a0 = (arc.angle_start_deg * Math.PI) / 180
  const a1 = (arc.angle_end_deg * Math.PI) / 180
  // Stored sweep: a0 -> a1, turning ccw ? +1 : -1. Walking the chain backward
  // swaps the endpoints AND flips the turn direction.
  const startA = reversed ? a1 : a0
  const endA = reversed ? a0 : a1
  const turnCcw = arc.ccw !== reversed  // ccw XOR reversed
  const xAxis = plane.x_axis as Vec3
  if (turnCcw) {
    // Increasing param in the (x_axis, normal x x_axis) frame is CCW.
    let u1 = endA
    while (u1 <= startA) u1 += 2 * Math.PI
    return makeArcEdge(oc, scope, center3d, plane.normal as Vec3, xAxis, arc.radius, startA, u1)
  }
  // CW: flip the circle axis so the CW turn becomes increasing param. In the
  // flipped frame a sketch angle theta sits at param -theta, so the edge still
  // runs geometrically start -> end.
  const flipped: Vec3 = [-plane.normal[0], -plane.normal[1], -plane.normal[2]]
  let u1 = -endA
  while (u1 <= -startA) u1 += 2 * Math.PI
  return makeArcEdge(oc, scope, center3d, flipped, xAxis, arc.radius, -startA, u1)
}

/** The two endpoint coordinates of an edge (the explorer yields its 2 vertices). */
function edgeEndpoints(oc: OccModule, scope: DisposeScope, edge: OccShape): [number[], number[]] {
  const pts: number[][] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(edge, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  while (exp.More()) {
    const v = scope.track(oc.TopoDS.Vertex_1(exp.Current()))
    const p = scope.track(oc.BRep_Tool.Pnt(v))
    pts.push([p.X(), p.Y(), p.Z()])
    exp.Next()
  }
  if (pts.length < 2) throw new Error('sweep: edge has fewer than 2 vertices')
  return [pts[0], pts[pts.length - 1]]
}

function dist3(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * Resolve one or more sweep path references to ordered world-space spine edges
 * (mirrors `_collect_path_edges`, extended for multi-pick / edge-precise
 * selection). All contributed edges must form one connected chain. Returns
 * [spineEdges, firstPathSketchId].
 *
 * Joint snapping: an arc edge's endpoints are forced onto the ideal circle by
 * OCC, so they sit ~1e-7..1e-6 off the solver's joint point (this is normal
 * kernel precision, NOT a solver defect). That sub-micron gap is above
 * BRepBuilderAPI_MakeWire's confusion tolerance, so a line FOLLOWING an arc
 * fails to attach and the wire collapses (the "second segment broken" bug).
 * We make the arc endpoints authoritative and build the neighbouring line
 * edges to those exact coordinates, so every joint coincides and the wire
 * assembles without relying on the solver hitting any particular precision.
 */
export function collectPathEdges(
  oc: OccModule,
  scope: DisposeScope,
  pathRefs: string | string[],
  globalRepo: Repository,
): [OccShape[], string] {
  const [ordered, firstSketchId] = orderedPathWorldEdges(pathRefs, globalRepo)
  const n = ordered.length

  // Chain-forward intended endpoints (world topology coords) of each edge.
  const S = ordered.map(({ edge: e, reversed }) => (reversed ? e.end : e.start) as number[])
  const T = ordered.map(({ edge: e, reversed }) => (reversed ? e.start : e.end) as number[])

  // Build arcs first and record their ACTUAL occ endpoints (the rigid joints
  // lines snap to). Match each occ vertex to the intended s/t by proximity.
  const arcShape: (OccShape | null)[] = new Array(n).fill(null)
  const aStart: number[][] = new Array(n)
  const aEnd: number[][] = new Array(n)
  ordered.forEach(({ edge: e, reversed }, i) => {
    if (e.kind === 'arc' && '_arc' in e) {
      const shp = spineArcEdge(oc, scope, e._plane as PlaneLike, e._arc as ArcParams, reversed)
      const [v0, v1] = edgeEndpoints(oc, scope, shp)
      ;[aStart[i], aEnd[i]] = dist3(v0, S[i]) <= dist3(v1, S[i]) ? [v0, v1] : [v1, v0]
      arcShape[i] = shp
    }
  })

  // Canonical joint coordinate at each edge boundary: an adjacent arc's actual
  // endpoint wins; two lines already share an exact topology vertex.
  const startOf = (i: number): number[] =>
    arcShape[i] ? aStart[i] : i > 0 && arcShape[i - 1] ? aEnd[i - 1] : S[i]
  const endOf = (i: number): number[] =>
    arcShape[i] ? aEnd[i] : i < n - 1 && arcShape[i + 1] ? aStart[i + 1] : T[i]

  const spineEdges: OccShape[] = ordered.map(({ edge: e }, i) => {
    if (e.kind === 'arc' && '_arc' in e) {
      return scope.track(arcShape[i] as OccShape)
    }
    return scope.track(makeLineEdge(oc, scope, startOf(i) as Vec3, endOf(i) as Vec3))
  })
  return [spineEdges, firstSketchId]
}

/** Solve a sweep feature into the body store (mirrors `_solve_sweep`). */
export function solveSweep(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): { [key: string]: unknown; status: string; body_id: string; body_ids?: string[] } {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.sweep as Dict) ?? {}
  const mergeTarget = ((sub.merge_target as string) ?? (feature.merge_target as string)) ?? null
  const merged: Dict = { ...sub, ...feature }

  const sketchRaw = merged.sketch
  const rawRefs: string[] = Array.isArray(sketchRaw)
    ? (sketchRaw as string[]).filter((s) => s)
    : sketchRaw
      ? [sketchRaw as string]
      : []
  const pathRaw = merged.path
  const pathRefs: string[] = Array.isArray(pathRaw)
    ? (pathRaw as string[]).filter((s) => s)
    : pathRaw
      ? [pathRaw as string]
      : []

  if (rawRefs.length === 0) throw new Error('sweep: requires at least one profile reference')
  if (pathRefs.length === 0) throw new Error('sweep: requires a path reference')

  // Partition profile refs. `entity:`/`vertex:` picks are edge-precise: only the
  // picked entity's edges contribute, and several picks on one sketch assemble
  // into a single loop. Region/sketch refs (`?`/`@`/`$`) keep routing through
  // collectExtrudeLoops, where face/region matching is already precise.
  const entityEidsBySketch = new Map<string, Set<string>>()
  const regionRefs: string[] = []
  for (const ref of rawRefs) {
    const picked = parseSketchEntityRef(ref)
    if (picked === null) {
      regionRefs.push(ref)
      continue
    }
    let set = entityEidsBySketch.get(picked.sketchId)
    if (!set) {
      set = new Set()
      entityEidsBySketch.set(picked.sketchId, set)
    }
    set.add(picked.eid)
  }

  const allLoops: Dict[][] = []
  const cqFaces: OccShape[] = []
  let firstPt: PlaneLike | null = null
  let firstSketchId = ''
  const profileErrors: string[] = []
  const profileQueries: string[] = []
  const faceNames: Record<string, string> = {}
  const edgeNames: Record<string, string> = {}
  const faceAncestry: Lineage = {}
  const edgeAncestry: Lineage = {}

  for (const sketchRef of [...new Set(regionRefs)]) {
    let resolved
    try {
      resolved = collectExtrudeLoops(oc, scope, table, sketchRef, featureId, 0.0, globalRepo, bodyStore)
    } catch (exc) {
      profileErrors.push(extractErrorMessage(exc))
      continue
    }
    if (resolved.face !== null) {
      cqFaces.push(resolved.face)
    } else {
      allLoops.push(...resolved.loops)
    }
    const topo = (globalRepo.elements.get('_topo_' + resolved.sketchId) as Dict | undefined) ?? {}
    for (const surface of (topo.surfaces as Dict[]) ?? []) {
      profileQueries.push(...surfaceEntityIds(surface))
    }
    if (firstPt === null) {
      firstPt = resolved.plane
      firstSketchId = resolved.sketchId
    }
  }

  // Edge-precise profiles: assemble the picked entities' topo edges into closed
  // loops (the same endpoint chaining collectExtrudeLoops uses for surfaces).
  for (const [sketchId, eids] of entityEidsBySketch) {
    const plane = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
    if (plane === undefined) {
      profileErrors.push(`sketch not found: ${sketchId}`)
      continue
    }
    const topo = (globalRepo.elements.get('_topo_' + sketchId) as Dict | undefined) ?? {}
    const edges = ((topo.edges as Dict[]) ?? []).filter((e) => eids.has(e.entity_id as string))
    const loops = extractProfileLoops([{ boundary: edges }])
    if (loops.length === 0) {
      profileErrors.push(`sweep: picked profile edges do not form a closed loop (sketch ${sketchId})`)
      continue
    }
    allLoops.push(...loops)
    for (const surface of (topo.surfaces as Dict[]) ?? []) {
      profileQueries.push(...surfaceEntityIds(surface))
    }
    if (firstPt === null) {
      firstPt = plane
      firstSketchId = sketchId
    }
  }

  if (profileErrors.length && cqFaces.length === 0 && allLoops.length === 0) {
    throw new Error(profileErrors.join('; '))
  }
  if (cqFaces.length > 0 && allLoops.length === 0) {
    throw new Error('sweep: face profiles are not yet supported; use a sketch profile')
  }
  if (allLoops.length === 0) throw new Error('sweep: no closed profile found')

  const [spineEdges] = collectPathEdges(oc, scope, pathRefs, globalRepo)

  const bodyId = 'body_' + featureId
  const result: { [key: string]: unknown; status: string; body_id: string; body_ids?: string[] } = { status: 'ok', body_id: bodyId }
  const operation = ((merged.operation as string) ?? 'add') as BodyOperation

  const lineage = sweepProfileWithLineage(oc, scope, allLoops, firstPt as PlaneLike, spineEdges, firstSketchId, featureId)
  const swept = scope.track(lineage.solid)
  for (const e of spineEdges) scope.release(e)
  Object.assign(faceNames, lineage.faceNames)
  Object.assign(edgeNames, lineage.edgeNames)
  Object.assign(faceAncestry, lineage.faceAncestry)
  Object.assign(edgeAncestry, lineage.edgeAncestry)

  const opResult = applyBodyOperation(oc, scope, table, {
    toolShape: swept,
    bodyStore,
    operation,
    mergeTarget,
    bodyId,
    featureId,
    sketchId: firstSketchId,
    opName: 'sweep',
    profileQueries,
    faceNames,
    edgeNames,
    faceAncestry,
    edgeAncestry,
  })
  Object.assign(result, opResult)

  if (profileErrors.length) {
    result.status = 'partial'
    result.exception = profileErrors.join('; ')
  }

  return result
}
