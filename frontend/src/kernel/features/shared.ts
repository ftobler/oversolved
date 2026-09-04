// solver_features_shared.py is the central machinery the leaf feature solvers
// (extrude/revolve/boolean/fillet/...) call into. It splits into two halves:
//
// - Pure logic: profile-loop assembly, direction resolution, body/merge-target resolution,
// top-face registration, direction/axis queries. No OCC. Ported here, gated byte-for-byte
// against a frozen snapshot of the Python functions' output (see features/shared.test.ts).
// - OCC-backed lineage: _apply_body_operation + _transfer_boolean_lineage +
// _resolve_face_profile (bodyOps.ts, booleanLineage.ts, faceProfile.ts). These call
// boolean ops, solid exploration, and face-geometry reads.
//
// Plane representation: Python distinguishes a Frame3D object from a plain plane dict via
// isinstance, but the two branches compute identical geometry. In TS both satisfy
// [[PlaneLike]], so the branch collapses to one path.

import type { Body, BrepDiff, Frame3D } from '../types3d'
import type { Repository } from '../query'
import { AmbiguousQueryError, parseAncestry } from '../query'
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

/**
 * Split a viewport sketch pick (`entity:<sketchId>:<eid>` or
 * `vertex:<sketchId>:<eid>:<sub>`) into the sketch and the entity it names.
 * Returns null for every other ref form (`$sketch`, `@feat/...`, `?...`).
 *
 * These are selection ids, not queries: the viewport toggles them into
 * `normalSelection` verbatim and the pick chips persist them unchanged (a
 * rewritten value would no longer match the re-click that unpicks it), so the
 * feature leaves have to understand the raw form. A `vertex:` pick names the
 * entity that owns the vertex, which is what both the sweep path and the
 * profile paths want from it.
 */
export function parseSketchEntityRef(ref: string): { sketchId: string; eid: string } | null {
  if (!ref.startsWith('entity:') && !ref.startsWith('vertex:')) return null
  const parts = ref.split(':')
  const sketchId = parts[1] ?? ''
  const eid = parts[2] ?? ''
  if (!sketchId || !eid) return null
  return { sketchId, eid }
}

/**
 * Sketch a `?...` ancestry query is drawn on: the first ancestor token that
 * names a registered sketch plane (`_pt_<id>`). An area pick carries its sketch
 * as a bare `@<sketchId>` token beside the `@<sketchId>/<eid>` tokens that name
 * the curves bounding it, so the plane registry is what tells the two apart.
 * Returns null when no token names a sketch (a body-face query, say).
 */
export function sketchIdFromQuery(query: string, globalRepo: Repository): string | null {
  if (!query.startsWith('?')) return null
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return null
  }
  for (const id of ids) {
    if (!id.startsWith('@') || id.includes('/')) continue
    const candidate = id.slice(1)
    if (globalRepo.elements.get('_pt_' + candidate) !== undefined) return candidate
  }
  return null
}

/**
 * The one entity of `sketchId` a sketch-area query is bounded by, or null when
 * it names none or several. A click on the fill inside a lone circle and a click
 * on the circle itself are the same gesture as far as a feature is concerned, so
 * this is what lets the area form answer like the `entity:` form; a region
 * bounded by four lines names four entities and gets no single answer.
 */
export function soleEntityInQuery(query: string, sketchId: string): string | null {
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return null
  }
  const prefix = '@' + sketchId + '/'
  const named = [...new Set(ids.filter((i) => i.startsWith(prefix)))]
  return named.length === 1 ? named[0].slice(prefix.length) : null
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

/**
 * The stamped reason of every area in `surfaces` that will not build.
 *
 * This is what makes the `buildable`/`reason` stamp reach a human. The gate runs
 * in the solver worker and marks the area in the viewport, but the moment the
 * user actually needs the sentence is when they picked that area as a profile
 * and the feature refused: "no closed profile found" answers what happened and
 * not why. Reusing the existing red-feature message costs one line at each leaf
 * and needs no new UI surface.
 */
export function unbuildableAreaReasons(surfaces: Dict[]): string[] {
  const out: string[] = []
  for (const surface of surfaces) {
    if (surface.buildable !== false) continue
    const reason = typeof surface.reason === 'string' ? surface.reason : 'no reason recorded'
    if (!out.includes(reason)) out.push(reason)
  }
  return out
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
 * A ref that names several bodies where the caller can only use one. Its own
 * type because "ambiguous" and "not found" are opposite diagnoses -- leaves
 * that wrap a resolve failure in a friendlier message (array.ts) must let this
 * one through rather than tell the user the body does not exist while listing
 * the very ids that matched.
 */
export class AmbiguousBodyRefError extends Error {}

/**
 * The single body a ref names, or null when it names none. Throws when the ref
 * names a FEATURE that owns several bodies: which sibling was meant is the
 * caller's question, and answering it with "the first one" is what let a
 * boolean subtract one half of a split body and report success.
 */
function singleBodyOf(ref: string, bodyStore: Record<string, Body>): Body | null {
  const ids = resolveBodyIds(ref, bodyStore)
  if (ids.length === 0) return null
  if (ids.length > 1) {
    throw new AmbiguousBodyRefError(
      `body ref '${ref}' is ambiguous: it names a feature owning ${ids.length} bodies ` +
      `(${ids.join(', ')}); name one of them`,
    )
  }
  return bodyStore[ids[0]]
}

/**
 * Resolve a body reference to its Body (mirrors `_resolve_body`). Accepts
 * "@feat", "feat", "body_feat", viewport selection forms ("face:id:...",
 * "entity:...", "body:id", "edge:...", "vertex:..."), and "?...:type" ancestry
 * queries (matched via their "@body_*" ancestors). Throws if nothing matches.
 *
 * Singular by contract -- every call site here wants ONE body (a boolean
 * target, a mirror source, a hole target). Exact body ids and `?` queries are
 * body-exact and always safe; a bare feature ref is only safe while that
 * feature owns one body, and fails loud otherwise (see `singleBodyOf`). Use
 * `resolveBodyIds` where every body of a feature is the right answer.
 */
export function resolveBody(ref: string, bodyStore: Record<string, Body>): Body {
  const direct = singleBodyOf(ref, bodyStore)
  if (direct !== null) return direct
  if (ref.includes(':')) {
    const parts = ref.split(':')
    if (parts.length >= 2) {
      const viewport = singleBodyOf(parts[1], bodyStore)
      if (viewport !== null) return viewport
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

/** `@<body-or-feature>/face|edge|vertex/<index>` -- see `topoFallbackQuery`. */
const TOPO_FALLBACK_REF = /^@([^/]+)\/(?:face|edge|vertex)\/\d+$/

/**
 * Every body id a ref names, or `[]` when it names none. The plural counterpart
 * to `resolveBody`, and the one place the feature->bodies direction is decided.
 *
 * A FEATURE id resolves to every body that feature made, not just the first.
 * One feature routinely owns several bodies -- it produced disjoint solids, or a
 * later cut severed what it produced (features/bodySplit.ts) -- so returning
 * only the first meant "cut everything @extrude1 made" quietly cut one half and
 * left the other standing.
 *
 * Callers decide what "no match" means, which is why this returns `[]` rather
 * than throwing: the merge-target and delete-body errors read differently, and
 * delete-body still falls back to `resolveBody` for viewport-prefix forms.
 */
export function resolveBodyIds(ref: string, bodyStore: Record<string, Body>): string[] {
  const key = ref.replace(/^@+/, '')
  // An exact body id names exactly that one sibling.
  if (key in bodyStore) return [key]
  // A topo-fallback element ref names the body it sits on. The render layer
  // mints this form whenever the kernel produced no named query for a face,
  // edge or vertex (utils/query/selectionId.ts topoFallbackQuery), so a face
  // pick can reach any body field as `@body_ex1/face/0`; without this branch
  // the leading segment fell through to the feature scan, missed, and the pick
  // resolved to nothing. `?` is handled below and never has this shape.
  const topo = TOPO_FALLBACK_REF.exec(ref)
  if (topo) return resolveBodyIds(topo[1], bodyStore)
  // A `?` ancestry query is body-exact: it resolves through one picked face or
  // edge, so the `@body_*` ancestor it carries IS the answer and no feature
  // scan applies. First match only, like `resolveBody` -- a query can name more
  // than one body (a boolean face descends from both inputs), and the owner is
  // the first one written.
  if (ref.startsWith('?')) {
    try {
      const [ids] = parseAncestry(ref)
      for (const aid of ids) {
        if (aid.startsWith('@body_') && aid.slice(1) in bodyStore) return [aid.slice(1)]
      }
    } catch {
      // unparseable query: fall through, the ref names nothing
    }
    return []
  }
  // Otherwise the ref names a FEATURE. The creator scan has to come before the
  // `body_<key>` lookup: the first sibling is literally called `body_<feature>`,
  // so that lookup would match it and hide the rest.
  const byCreator = Object.entries(bodyStore)
    .filter(([, body]) => body.created_by === key)
    .map(([bid]) => bid)
  if (byCreator.length > 0) return byCreator
  const prefixed = 'body_' + key
  if (prefixed in bodyStore) return [prefixed]
  return []
}

/**
 * Resolve one PLURAL body ref to the store keys it names, throwing when it
 * names none. The resolver behind every multi-select body field (delete_body's
 * `bodies`, transform's `bodies`).
 *
 * A `?` query is body-exact -- it resolves through a specific face/edge, so it
 * names the one sibling that owns it, and that is what the UI picker writes. A
 * plain ref may instead name a FEATURE, and a feature owns every body it made
 * (features/bodySplit.ts): `['@extrude1']` has to name `body_extrude1` AND its
 * split siblings, not quietly leave the other halves behind. `resolveBody` is
 * still the fallback for the viewport-prefix forms (`face:id:...`) it alone
 * understands.
 *
 * `leaf` only names the caller in the error message, so a failed pick reads as
 * the feature the user was editing.
 */
export function resolveBodyRefKeys(
  bodyQuery: string,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  leaf: string,
): string[] {
  if (!bodyQuery.startsWith('?')) {
    const ids = resolveBodyIds(bodyQuery, bodyStore)
    return ids.length > 0 ? ids : [resolveBody(bodyQuery, bodyStore).id]
  }
  // The repo goes first because it is the precise answer: it resolves the picked
  // face itself and reads the body that owns it, which is what disambiguates a
  // boolean face descending from two inputs.
  let resolved: Dict | null = null
  try {
    resolved = globalRepo.query(bodyQuery, null, bodyStore) as Dict | null
  } catch (e) {
    // An ambiguous query is not an error for THIS question. A face with no
    // construction UUID, no ancestor tokens and no classifier is named by its
    // body alone (kernel/faceQuery.ts), so every such face of that body shares
    // one query string -- routine on imported geometry, where picking one face
    // of a 56-face part matched all 56 and failed the solve. Every candidate
    // sits on the same body by construction, since they all had to carry the
    // `@body_*` token the query matched on, so the body is unambiguous even
    // though the face is not. Anything else the repo throws is a real failure.
    if (!(e instanceof AmbiguousQueryError)) throw e
  }
  // A resolved Body carries created_by + id; a geometry dict carries body_id.
  if (resolved !== null) {
    if ('created_by' in resolved && typeof resolved.id === 'string') return [resolved.id]
    if (resolved.body_id) return [String(resolved.body_id)]
  }
  // Also the path for a face the user picked that no longer exists -- a later
  // edit reshaped the body under it. The body still does, and it is the body
  // this feature names, so read the `@body_*` ancestor out of the query rather
  // than failing the whole solve over an element nobody asked to keep.
  const ids = resolveBodyIds(bodyQuery, bodyStore)
  if (ids.length > 0) return ids
  throw new Error(`${leaf}: query did not resolve to a body: ${JSON.stringify(bodyQuery)}`)
}

/**
 * Every store key a list of body refs names, in pick order, deduplicated.
 *
 * Resolution happens against the INTACT store before any caller acts on the
 * result: two picks landing on the same body (different faces) must collapse
 * into one entry rather than letting the second ref fail against a slot the
 * first already consumed.
 */
export function resolveBodyRefList(
  bodyQueries: string[],
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  leaf: string,
): string[] {
  const keys: string[] = []
  for (const bodyQuery of bodyQueries) {
    for (const key of resolveBodyRefKeys(bodyQuery, globalRepo, bodyStore, leaf)) {
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

/**
 * Body IDs a body operation should target (mirrors `_resolve_merge_targets`).
 * Empty/None merge target means ALL bodies; anything else goes through
 * `resolveBodyIds`.
 */
export function resolveMergeTargets(
  mergeTarget: string | null | undefined,
  bodyStore: Record<string, Body>,
): string[] {
  if (!mergeTarget) return Object.keys(bodyStore)
  const ids = resolveBodyIds(mergeTarget, bodyStore)
  if (ids.length === 0) throw new Error(`extrude: body not found for merge_target '${mergeTarget}'`)
  return ids
}

// ─── BrepDiff predicate ───

/**
 * Merge two BrepDiffs by concatenating every classification list.
 * Returns `b` when `a` is null (first cut in a loop).
 */
export function mergeBrepDiff(a: BrepDiff | null, b: BrepDiff): BrepDiff {
  if (a === null) return b
  return {
    new_faces: [...a.new_faces, ...b.new_faces],
    inherited_faces: [...a.inherited_faces, ...b.inherited_faces],
    new_edges: [...a.new_edges, ...b.new_edges],
    inherited_edges: [...a.inherited_edges, ...b.inherited_edges],
    modified_input_faces: [...a.modified_input_faces, ...b.modified_input_faces],
    deleted_input_faces: [...a.deleted_input_faces, ...b.deleted_input_faces],
    modified_input_edges: [...a.modified_input_edges, ...b.modified_input_edges],
    deleted_input_edges: [...a.deleted_input_edges, ...b.deleted_input_edges],
  }
}

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

/**
 * True when two sketch planes are the same plane: same normal direction, same
 * offset along it, and same in-plane rotation, within the world vertex-merge
 * tolerance. Two sketches on one datum plane are a legitimate multi-sketch
 * profile; two on different planes are not -- every loop is lifted through the
 * FIRST plane's frame, so the second profile silently builds in the wrong place.
 */
export function samePlane(a: PlaneLike, b: PlaneLike, tol = 1e-5): boolean {
  const [an, bn] = [a.normal as number[], b.normal as number[]]
  const d = an[0] * bn[0] + an[1] * bn[1] + an[2] * bn[2]
  if (Math.abs(d - 1) > 1e-6) return false
  const ao = a.origin as number[]
  const bo = b.origin as number[]
  const off = (bo[0] - ao[0]) * an[0] + (bo[1] - ao[1]) * an[1] + (bo[2] - ao[2]) * an[2]
  if (Math.abs(off) > tol) return false
  // A second sketch's loop coords are relative to ITS frame; the feature lifts
  // them through the FIRST frame, so the in-plane rotation must match too.
  // y_axis follows from normal and x_axis, so comparing x_axis is enough.
  const ax = a.x_axis as number[]
  const bx = b.x_axis as number[]
  const r = ax[0] * bx[0] + ax[1] * bx[1] + ax[2] * bx[2]
  return Math.abs(r - 1) <= 1e-6
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

  // Cylindrical face: prefer surface_frame (the analytic axis origin) over
  // the centroid, which for a partial cylinder may not lie on the axis.
  if (data.axis && data.type === 'cylinderface') {
    const dir = normalize3(data.axis as number[])
    if (dir) {
      const sf = (data.surface_frame as { origin?: number[]; axis?: number[] } | undefined)
      const origin = sf?.origin ?? (data.origin as number[] | undefined) ?? (data.centroid as number[] | undefined) ?? [0, 0, 0]
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
