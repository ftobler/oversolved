// solver_features_shared.py is the central machinery the leaf feature solvers
// (extrude/revolve/boolean/fillet/...) call into. It splits into two halves:
//
// - Pure logic: profile-loop assembly, direction resolution, body/merge-target resolution,
// top-face registration, direction/axis queries. No OCC. Ported here, gated byte-for-byte
// against a frozen snapshot of the Python functions' output (see features/shared.test.ts). -
// OCC-backed lineage: _apply_body_operation + _transfer_boolean_lineage +
// _resolve_face_profile. These call boolean ops, solid exploration, and face-geometry reads;
// they land in a later 2e shard against the OCC adapter.
//
// Plane representation: Python distinguishes a Frame3D object from a plain plane dict via
// isinstance, but the two branches compute identical geometry. In TS both satisfy
// [[PlaneLike]], so the branch collapses to one path.

import type { Body, BrepDiff, Frame3D } from '../types3d'
import type { Repository } from '../query'
import { parseAncestry } from '../query'
import { loopCentroid } from '../profileLoops'
import { TOL_LOOP_CLOSURE } from '../solverConstants'

/** A plane as either a Frame3D or a plain `{origin, x_axis, y_axis, normal}` dict. */
export interface PlaneLike {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
  normal: number[]
}

type Dict = Record<string, unknown>

/** Python `x % m` (result takes the divisor's sign), unlike JS `%`. */
export function pymod(x: number, m: number): number {
  return ((x % m) + m) % m
}

/**
 * Sorted, deduped entity ids referenced by a surface's ancestry query, or `[]`
 * if the query is absent/non-ancestry/unparsable. Dedup mirrors Python's
 * frozenset, since parseAncestry can repeat ids.
 */
export function surfaceEntityIds(surface: Dict): string[] {
  const query = (surface.query as string) ?? ''
  if (!query.startsWith('?')) return []
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return []
  }
  return [...new Set(ids.filter((i) => i.startsWith('@') && i.includes('/')))].sort()
}

// ─── Profile loops ───

/**
 * Assemble surface boundaries into ordered closed loops (mirrors
 * `_extract_profile_loops`). Each surface's boundary edges are chained by
 * endpoint proximity (within TOL_LOOP_CLOSURE), reversing edges as needed; a
 * reversed arc swaps its angles and flips `ccw`.
 */
export function extractProfileLoops(surfaces: Dict[]): Dict[][] {
  if (!surfaces || surfaces.length === 0) return []
  const TOL = TOL_LOOP_CLOSURE

  const dist2d = (a: number[], b: number[]): number =>
    Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)

  const allLoops: Dict[][] = []
  for (const surface of surfaces) {
    // Emit the outer boundary and every inner hole as separate loops;
    // classifyLoops re-nests them (outer + holes) for the OCC face.
    const holes = (surface.holes as Dict[][]) ?? []
    for (const boundary of [(surface.boundary as Dict[]) ?? [], ...holes]) {
    if (boundary.length === 0) continue

    // A full ellipse is a single self-closed edge with no shared endpoints: it is
    // its own complete loop. (The endpoint-chaining below needs start/end edges,
    // which a full ellipse lacks; a sliced ellipse arrives as ellipse_arc edges.)
    for (const e of boundary) if (e.kind === 'ellipse') allLoops.push([e])

    const rawEdges: [number[], number[], Dict][] = []
    for (const e of boundary) {
      if (e.kind === 'ellipse') continue
      const s = e.start as number[] | undefined | null
      const en = e.end as number[] | undefined | null
      if (s !== undefined && s !== null && en !== undefined && en !== null) {
        rawEdges.push([s, en, e])
      }
    }
    if (rawEdges.length < 1) continue

    const used = new Set<number>()
    let current = [...rawEdges[0][0]]
    const loop: Dict[] = []

    for (let _i = 0; _i < rawEdges.length; _i++) {
      let foundNext = false
      for (let i = 0; i < rawEdges.length; i++) {
        if (used.has(i)) continue
        const [s, e, edict] = rawEdges[i]
        const forward = dist2d(current, s) <= TOL
        const reverse = dist2d(current, e) <= TOL
        if (forward || reverse) {
          if (forward) {
            loop.push(edict)
            current = [...e]
          } else {
            const rev: Dict = { ...edict }
            rev.start = [...(edict.end as number[])]
            rev.end = [...(edict.start as number[])]
            // Arc and elliptical-arc carry an angle range + winding that must flip
            // too, else the OCC edge builder rebuilds the wrong (stale) curve.
            if (edict.kind === 'arc' || edict.kind === 'ellipse_arc') {
              rev.angle_start_deg = (edict.angle_end_deg as number) ?? 0
              rev.angle_end_deg = (edict.angle_start_deg as number) ?? 0
              rev.ccw = !((edict.ccw as boolean) ?? true)
            }
            loop.push(rev)
            current = [...s]
          }
          used.add(i)
          foundNext = true
          break
        }
      }
      if (!foundNext) break
      if (dist2d([...rawEdges[0][0]], current) <= TOL && loop.length >= 1) {
        allLoops.push(loop)
        break
      }
    }
    }
  }

  return allLoops
}

// ─── Top-face registration ───

/**
 * Register the swept top face (and its first edge) of an extrude so later
 * sketches/queries can reference them (mirrors `_register_top_face`). The top
 * centroid is the area-weighted loop centroid lifted to the sketch plane and
 * pushed by `distance` along the normal.
 */
export function registerTopFace(
  globalRepo: Repository,
  featureId: string,
  pt: PlaneLike,
  surfaces: Dict[],
  distance: number,
): void {
  const origin = pt.origin
  const xAxis = pt.x_axis
  const yAxis = pt.y_axis
  const normal = pt.normal

  const boundary = surfaces.length ? ((surfaces[0].boundary as Dict[]) ?? []) : []
  const [u, v] = loopCentroid(boundary)

  const sketchCentroid = [
    origin[0] + u * xAxis[0] + v * yAxis[0],
    origin[1] + u * xAxis[1] + v * yAxis[1],
    origin[2] + u * xAxis[2] + v * yAxis[2],
  ]
  const topCentroid = [
    sketchCentroid[0] + normal[0] * distance,
    sketchCentroid[1] + normal[1] * distance,
    sketchCentroid[2] + normal[2] * distance,
  ]
  const topPlaneOrigin = [
    origin[0] + normal[0] * distance,
    origin[1] + normal[1] * distance,
    origin[2] + normal[2] * distance,
  ]

  globalRepo.register(featureId + '/top_face', {
    type: 'flatface',
    centroid: topCentroid,
    normal: [...normal],
    origin: topPlaneOrigin,
    x_axis: [...xAxis],
    y_axis: [...yAxis],
  })

  if (surfaces.length && (surfaces[0].boundary as Dict[])?.length) {
    const edge = (surfaces[0].boundary as Dict[])[0]
    if ('start' in edge && 'end' in edge) {
      const s2d = edge.start as number[]
      const e2d = edge.end as number[]
      const s3d = [
        origin[0] + s2d[0] * xAxis[0] + s2d[1] * yAxis[0] + normal[0] * distance,
        origin[1] + s2d[0] * xAxis[1] + s2d[1] * yAxis[1] + normal[1] * distance,
        origin[2] + s2d[0] * xAxis[2] + s2d[1] * yAxis[2] + normal[2] * distance,
      ]
      const e3d = [
        origin[0] + e2d[0] * xAxis[0] + e2d[1] * yAxis[0] + normal[0] * distance,
        origin[1] + e2d[0] * xAxis[1] + e2d[1] * yAxis[1] + normal[1] * distance,
        origin[2] + e2d[0] * xAxis[2] + e2d[1] * yAxis[2] + normal[2] * distance,
      ]
      globalRepo.register(featureId + '/top_face/edge0', {
        type: 'straightedge',
        start: s3d,
        end: e3d,
      })
    }
  }
}

// ─── Direction resolution ───

/**
 * Resolve an extrude/revolve direction string to (direction_vec, distance,
 * effective_plane) (mirrors `_resolve_direction`). `reverse` flips the normal;
 * `symmetric` keeps the normal but shifts the plane origin back by half the
 * distance so the solid straddles the sketch plane.
 */
export function resolveDirection(
  normal: number[],
  pt: PlaneLike,
  direction: string,
  distance: number,
): [number[], number, PlaneLike] {
  if (direction === 'reverse') {
    return [normal.map((n) => -n), distance, pt]
  }
  if (direction === 'symmetric') {
    const directionVec = [...normal]
    const shift = normal.map((n) => (-n * distance) / 2)
    const shifted: PlaneLike = {
      origin: [pt.origin[0] + shift[0], pt.origin[1] + shift[1], pt.origin[2] + shift[2]],
      x_axis: pt.x_axis,
      y_axis: pt.y_axis,
      normal: pt.normal,
    }
    return [directionVec, distance, shifted]
  }
  return [[...normal], distance, pt]
}

// ─── Body resolution ───

/**
 * Resolve a body reference to its Body (mirrors `_resolve_body`). Accepts
 * "@feat", "feat", "body_feat", viewport selection forms ("face:id:...",
 * "entity:...", "body:id", "edge:...", "vertex:..."), and "?...:type" ancestry
 * queries (matched via their "@body_*" ancestors). Throws if nothing matches.
 */
export function resolveBody(ref: string, bodyStore: Record<string, Body>): Body {
  const key = ref.replace(/^@+/, '')
  if (key in bodyStore) return bodyStore[key]
  const prefixed = 'body_' + key
  if (prefixed in bodyStore) return bodyStore[prefixed]
  for (const body of Object.values(bodyStore)) {
    if (body.created_by === key) return body
  }
  if (ref.startsWith('?')) {
    try {
      const [ids] = parseAncestry(ref)
      for (const aid of ids) {
        if (aid.startsWith('@body_')) {
          const bid = aid.slice(1)
          if (bid in bodyStore) return bodyStore[bid]
        }
      }
    } catch {
      // fall through to the viewport-prefix and error paths
    }
  }
  if (ref.includes(':')) {
    const parts = ref.split(':')
    if (parts.length >= 2) {
      const candidate = parts[1]
      if (candidate in bodyStore) return bodyStore[candidate]
      const bodyPrefixed = 'body_' + candidate
      if (bodyPrefixed in bodyStore) return bodyStore[bodyPrefixed]
      for (const body of Object.values(bodyStore)) {
        if (body.created_by === candidate) return body
      }
    }
  }
  throw new Error(`body not found for ref '${ref}'`)
}

/**
 * Build an empty Body shell with default fields (shape is assigned by the caller
 * after registration). Mirrors Python Body(id, created_by, shape, sketch_id).
 */
export function bareBody(id: string, createdBy: string, sketchId = ''): Body {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape: null,
    sketch_id: sketchId,
    brep_diff: null,
    profile_queries: [],
  }
}

/**
 * Body IDs a body operation should target (mirrors `_resolve_merge_targets`).
 * Empty/None merge target means ALL bodies; otherwise the ref resolves to one.
 */
export function resolveMergeTargets(
  mergeTarget: string | null | undefined,
  bodyStore: Record<string, Body>,
): string[] {
  if (!mergeTarget) return Object.keys(bodyStore)
  const key = mergeTarget.replace(/^@+/, '')
  if (key in bodyStore) return [key]
  const prefixed = 'body_' + key
  if (prefixed in bodyStore) return [prefixed]
  for (const [bid, body] of Object.entries(bodyStore)) {
    if (body.created_by === key) return [bid]
  }
  throw new Error(`extrude: body not found for merge_target '${mergeTarget}'`)
}

// ─── BrepDiff predicate ───

/**
 * True if a BrepDiff has no geometry change (mirrors `_brep_diff_is_empty`).
 * A null diff returns false (it represents "not computed", not "empty").
 */
export function brepDiffIsEmpty(diff: BrepDiff | null): boolean {
  if (diff === null) return false
  return (
    diff.new_faces.length === 0 &&
    diff.deleted_input_faces.length === 0 &&
    diff.modified_input_faces.length === 0 &&
    diff.new_edges.length === 0 &&
    diff.deleted_input_edges.length === 0 &&
    diff.modified_input_edges.length === 0
  )
}

// ─── Direction / axis queries ───

/** Transform 2D sketch coords to 3D world space (mirrors `_sketch_to_world_2d`). */
export function sketchToWorld2d(xy: number[], plane: PlaneLike): number[] {
  const [u, v] = xy
  return [
    plane.origin[0] + u * plane.x_axis[0] + v * plane.y_axis[0],
    plane.origin[1] + u * plane.x_axis[1] + v * plane.y_axis[1],
    plane.origin[2] + u * plane.x_axis[2] + v * plane.y_axis[2],
  ]
}

function normalize3(d: number[]): number[] | null {
  const length = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
  if (length > 1e-12) return [d[0] / length, d[1] / length, d[2] / length]
  return null
}

/**
 * Resolve a query to a 3D line {start, direction}, shared by the direction/axis
 * resolvers. Handles these pickable geometries: straight edge ({start, end}),
 * circular/arc/ellipse edge ({center, axis}), sketch line/circle/arc
 * ({external_params, kind}) lifted through the sketch plane, cylindrical face
 * (type + axis), and planar face (normal).
 *
 * Edge payloads from edgeAncestryPayload carry all geometry keys (start, end,
 * center, axis, ...) regardless of the actual edge kind, with undefined for
 * inapplicable fields. Truthy checks guard against mismatches (a circular edge
 * has undefined start/end; a straight edge has undefined center/axis).
 */
function resolveQueryToLine(
  query: string,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null,
): { start: number[]; dir: number[] } | null {
  if (!query) return null
  const data = globalRepo.query(query, null, bodyStore) as Dict | null
  if (!data) return null

  // Straight 3D edge: truthy start/end (circular edges carry undefined start/end).
  if (data.start && data.end) {
    const start = data.start as number[]
    const end = data.end as number[]
    const dir = normalize3([end[0] - start[0], end[1] - start[1], end[2] - start[2]])
    if (dir) return { start, dir }
  }

  // Circular / arc / ellipse edge: truthy center/axis (straight edges carry
  // undefined center/axis).
  if (data.center && data.axis) {
    const dir = normalize3(data.axis as number[])
    if (dir) {
      const center = data.center as number[]
      return { start: [...center], dir }
    }
  }

  // Sketch line / circle / arc: lifted through the sketch plane.
  if (data && 'external_params' in data) {
    const sketchId = (data.sketch_id as string) ?? ''
    const plane = sketchId ? (globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined) : undefined
    if (plane) {
      const params = data.external_params as number[]
      if (data.kind === 'line') {
        const start = sketchToWorld2d(params.slice(0, 2), plane)
        const end = sketchToWorld2d(params.slice(2, 4), plane)
        const dir = normalize3([end[0] - start[0], end[1] - start[1], end[2] - start[2]])
        if (dir) return { start, dir }
      } else if (data.kind === 'circle' || data.kind === 'arc') {
        // Circle/arc centre in 2D [cx, cy] → 3D; axis = sketch plane normal.
        const start = sketchToWorld2d(params.slice(0, 2), plane)
        const dir = normalize3(plane.normal)
        if (dir) return { start, dir }
      }
    }
  }

  // Cylindrical face: cylinder axis anchored at the centroid.
  if (data.axis && data.type === 'cylinderface') {
    const dir = normalize3(data.axis as number[])
    if (dir) {
      const origin = (data.origin as number[] | undefined) ?? (data.centroid as number[] | undefined) ?? [0, 0, 0]
      return { start: [...origin], dir }
    }
  }

  // Planar face: the array runs along the face normal.
  if (data && 'normal' in data) {
    const dir = normalize3(data.normal as number[])
    if (dir) {
      const origin = (data.origin as number[] | undefined) ?? (data.centroid as number[] | undefined) ?? [0, 0, 0]
      return { start: [...origin], dir }
    }
  }

  return null
}

/**
 * Resolve a direction query to a unit vector (mirrors `_resolve_direction_query`).
 * Handles both 3D edge results ({start, end}) and 2D sketch-line results
 * ({external_params, kind: "line", sketch_id}) lifted through their plane.
 * Returns `fallback` when the query is empty or yields no usable direction.
 */
export function resolveDirectionQuery(
  query: string,
  globalRepo: Repository,
  fallback: number[],
  bodyStore: Record<string, unknown> | null = null,
): number[] {
  const line = resolveQueryToLine(query, globalRepo, bodyStore)
  return line ? line.dir : fallback
}

/**
 * Resolve an axis query to (origin, unit direction) (mirrors `_resolve_axis_query`).
 * Same data shapes as `resolveDirectionQuery`; the axis origin is the line start.
 * Returns the fallbacks when the query is empty or yields no usable axis.
 */
export function resolveAxisQuery(
  query: string,
  globalRepo: Repository,
  fallbackOrigin: number[],
  fallbackDirection: number[],
  bodyStore: Record<string, unknown> | null = null,
): [number[], number[]] {
  const line = resolveQueryToLine(query, globalRepo, bodyStore)
  return line ? [[...line.start], line.dir] : [fallbackOrigin, fallbackDirection]
}

/**
 * Resolve a direction query to a unit vector, or `null` when the query is empty
 * or does not resolve to a usable edge/face. Unlike `resolveDirectionQuery`
 * there is no silent world-axis fallback: the array leaf treats `null` as a
 * solve error so an unpicked direction never arrays along an arbitrary axis.
 */
export function resolveDirectionQueryStrict(
  query: string,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null = null,
): number[] | null {
  const line = resolveQueryToLine(query, globalRepo, bodyStore)
  return line ? line.dir : null
}

/**
 * Resolve an axis query to (origin, unit direction), or `null` when the query is
 * empty or does not resolve to a usable edge/face. The strict counterpart to
 * `resolveAxisQuery`; the circular-array leaf treats `null` as a solve error so
 * an unpicked axis never rotates about an arbitrary line.
 */
export function resolveAxisQueryStrict(
  query: string,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null = null,
): [number[], number[]] | null {
  const line = resolveQueryToLine(query, globalRepo, bodyStore)
  return line ? [[...line.start], line.dir] : null
}

// Re-export so the Frame3D type is visible to consumers of PlaneLike.
export type { Frame3D }
