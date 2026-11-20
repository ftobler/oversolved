// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Mutation, Entity } from '@/types/cad'
import type { SnapKind } from '@/registry'
import { suggestConstraint } from '@/registry'
import { getEntityKind } from '@/types/cad'
import { nearestPointOnEntity } from '@/utils/geometry/nearestPoint'
import { geomPoint } from '@/utils/geometry/geometryMapping'
import { pickRadiusPx } from '@/picking/screenSpaceScale'
import { SNAP_EPS } from '@/utils/geometry/snapTolerance'

/** The hover/snap signals a draw click resolves against. Owned here because
 *  this module, not the per-tool click math, decides what they mean. */
export interface DrawSnapState {
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: SnapKind | null
  // Composite ID: "entity:featureId:entityId" or null
  hoveredSelectionId: string | null
  /** Curve kind of the hovered body edge ('line'|'circle'|'arc'|'spline'),
   *  used by the project tool to choose the projected entity kind. */
  hoveredSourceKind?: string | null
  /** When the hovered selection is a body face, the projection sources of its
   *  boundary edges. The project tool lowers a face pick into one projected
   *  entity per boundary edge (a closed wire). */
  hoveredFaceEdges?: { source: string; kind: string }[] | null
  // One carried ref per already-placed draw point, index-aligned with them.
  drawSnapRefs: (string | null)[]
  alignmentSnapPoint: [number, number] | null
  // An alignment snap is measured against the last draw point, i.e. the segment's
  // own start. It names no second vertex, which is why there is no id here.
  alignmentSnapKind: 'kinda_horizontal' | 'kinda_vertical' | null
  // Side count for the two-click n-gon tool. Defaults to 6 when absent.
  ngonSides?: number
  /** World units spanned by one screen pixel on the sketch plane. When set, a
   *  vertex snap must lie within the ID buffer's pick reach of the click, so a
   *  hover the pointer has already left cannot claim it. Absent for headless
   *  callers, whose vertex id was itself resolved at the click pixel. */
  pixelSize?: number | null
}

/** The solved geometry a path snap needs to find its foot on a curve. Both
 *  fields are the ones `computeDrawClick` already receives. */
export interface SketchGeometry {
  sketch?: Record<string, Entity>
  otherSketches?: Record<string, Record<string, Entity>>
}

/** Click positions that agree within this distance are the same point. Kept in
 *  a pure sibling so the document writers can share the tolerance; re-exported
 *  here for the draw path's existing imports. */
export { SNAP_EPS }

// Only these carry a well-defined foot for a cursor point, so only these can
// host a point. A spline or an ellipse under the cursor is not a snap target.
const SNAPPABLE_PATH_KINDS = new Set(['line', 'circle', 'arc'])

/** What the snap under a draw click asks the document to record.
 *
 *  The three snaps that can resolve one click are not the same kind of
 *  statement and must not collapse into one. Landing on an existing vertex says
 *  "these two points are the same point": a coincident between a point pair.
 *  Landing on a curve says "this point lies somewhere on that curve": the locus
 *  form of coincident, which pins one degree of freedom, not two. An alignment
 *  snap says "this segment runs along an axis"; it is measured against the last
 *  draw point, which is the segment's OWN start, so it constrains the entity and
 *  names no second element at all. */
export type InsertSnap =
  | { kind: 'coincident'; vertexId: string; at: [number, number] }
  | { kind: 'point_on_path'; entityRef: string; at: [number, number] }
  | { kind: 'horizontal' | 'vertical' }

/** Where the entity being inserted accepts a constraint. A tool fills in the
 *  refs it has: its own vertex for a point pair or a locus, itself for an axis
 *  constraint. A snap with no matching ref authors nothing, which is how a
 *  `point` entity declines a horizontal without either side knowing about the
 *  other. */
export interface InsertTarget {
  featureId: string
  // The new entity's own vertex, e.g. `vertex:S1:E4:center`.
  vertexRef?: string
  // The new entity itself, e.g. `entity:S1:E4`.
  entityRef?: string
}

/** The named vertex's real position, read from the sketch geometry the caller
 *  already holds. A sketch vertex hover publishes only an id (the vertex ID
 *  layer registers no coordinate), and the ref names the entity and key the
 *  point lives at, so the entity is the authoritative source. The origin ref is
 *  not a sketch entity; its position comes from the caller (activeOriginLocal). */
export function vertexPositionAt(ref: string, geo: SketchGeometry = {}): [number, number] | null {
  if (!ref.startsWith('vertex:')) return null
  const parts = ref.slice('vertex:'.length).split(':')
  if (parts.length < 3 || parts[parts.length - 1] === '') return null
  const featureId = parts[0]
  const vertexKey = parts[parts.length - 1]
  const entityId = parts.slice(1, -1).join(':')
  const entity = geo.otherSketches?.[featureId]?.[entityId] ?? geo.sketch?.[entityId]
  if (!entity) return null
  return geomPoint({ [entityId]: entity }, { entity: entityId, point: vertexKey })
}

/** Two pick reaches, in screen pixels. The ID buffer accepts a mark up to one
 *  reach away; the second covers a sketch plane seen at an angle, where a
 *  world-space distance foreshortens on screen. */
const VERTEX_SNAP_REACH_PX = 2 * (pickRadiusPx() + 1)

/** The position of the hovered vertex: the entity's own coordinate when this
 *  document can resolve the ref, else whatever the hover published (the origin
 *  marker publishes its sketch-frame position). */
function vertexSnapPoint(snap: DrawSnapState, geo: SketchGeometry): [number, number] | null {
  if (!snap.hoveredVertexId) return null
  return vertexPositionAt(snap.hoveredVertexId, geo) ?? snap.hoveredVertexPosition
}

/** The point under the cursor, if the click landed on one that can be named.
 *
 *  The vertex's own position is compared against the click, never the click
 *  against itself: a hover the pointer has already left must not claim it. The
 *  comparison runs in screen-scaled units when the caller knows the pixel size;
 *  a snap's id came from the press pixel otherwise, so it is taken as evidence.
 *  A ref whose entity is not in the geometry keeps its id and authors the
 *  coincident; its point then comes from the raw click and the solver pulls it
 *  onto the vertex. */
export function snappableVertexAt(
  snap: DrawSnapState,
  px: number,
  py: number,
  geo: SketchGeometry = {},
): string | null {
  const vertexId = snap.hoveredVertexId
  if (!vertexId) return null
  const at = vertexSnapPoint(snap, geo)
  if (!at) return snap.hoveredSnapKind ? vertexId : null
  const pixelSize = snap.pixelSize
  if (pixelSize != null && Number.isFinite(pixelSize) && pixelSize > 0) {
    const reach = VERTEX_SNAP_REACH_PX * pixelSize
    if (Math.hypot(px - at[0], py - at[1]) > reach) return null
  }
  return vertexId
}

/** The curve under the cursor and the foot of the cursor on it, if the hovered
 *  selection is a sketch curve this document can constrain against.
 *
 *  The hover id alone is not enough: the same field carries filled-area and
 *  B-rep picks, so the ref is only believed once it resolves to a real entity of
 *  a kind that has a foot. The thing snapped to does not have to be a point. */
export function snappablePathAt(
  snap: DrawSnapState,
  rawPoint: readonly [number, number],
  geo: SketchGeometry,
): { entityRef: string; at: [number, number] } | null {
  const id = snap.hoveredSelectionId
  if (!id || !id.startsWith('entity:')) return null
  const parts = id.slice('entity:'.length).split(':')
  if (parts.length < 2) return null
  const featureId = parts[0]
  const entityId = parts.slice(1).join(':')

  const entity = geo.otherSketches?.[featureId]?.[entityId] ?? geo.sketch?.[entityId]
  if (!entity) return null
  if (!SNAPPABLE_PATH_KINDS.has(getEntityKind(entity))) return null

  const foot = nearestPointOnEntity(rawPoint[0], rawPoint[1], entity)
  if (!foot) return null
  return { entityRef: id, at: foot.position }
}

/** Resolve what a click asks to record.
 *
 *  A named vertex wins over both the axis and the curve it sits on: a point pair
 *  says strictly more than a locus, and strictly more than an axis measured
 *  against the segment's own start. The axis is dropped rather than added
 *  beside the vertex, because the coincident plus the vertex's own position
 *  already fixes the end, and a second relation between the two existing points
 *  could over-constrain them. An alignment still wins over a curve: the point
 *  lands on the axis the user saw the cursor follow. */
export function resolveInsertSnap(
  snap: DrawSnapState,
  rawPoint: readonly [number, number],
  geo: SketchGeometry = {},
): InsertSnap | null {
  const vertexId = snappableVertexAt(snap, rawPoint[0], rawPoint[1], geo)
  if (vertexId) {
    const at = vertexSnapPoint(snap, geo) ?? [rawPoint[0], rawPoint[1]]
    return { kind: 'coincident', vertexId, at }
  }
  if (snap.alignmentSnapPoint && snap.alignmentSnapKind) {
    const kind = suggestConstraint('vertex', snap.alignmentSnapKind)
    // The registry owns the snap -> constraint mapping; anything but the two
    // axis constraints means an alignment kind grew a meaning this branch does
    // not implement, and authoring a guess would poison the sketch.
    if (kind === 'horizontal' || kind === 'vertical') return { kind }
    return null
  }

  const path = snappablePathAt(snap, rawPoint, geo)
  if (path) return { kind: 'point_on_path', entityRef: path.entityRef, at: path.at }
  return null
}

/** Reads the element under the cursor once, then answers questions about it.
 *
 *  The questions are separate on purpose: a tool asks only the ones it can
 *  honour, so adding a snap kind means adding a predicate here and one `if` at
 *  the tools that can express it, instead of editing a single resolver that
 *  every tool shares. `update` is what re-reads the hover; nothing is cached
 *  across clicks. */
export interface InsertionHelper {
  // Re-read the element under the cursor for a click at `rawPoint`.
  update(snap: DrawSnapState, rawPoint: readonly [number, number]): void
  // Where the click lands once the snap has moved it: onto the alignment axis,
  // onto the hovered vertex, onto the foot on the hovered curve, or nowhere.
  getPoint(): [number, number]
  foundSnappablePoint(): boolean
  foundSnappablePath(): boolean
  foundHorizontal(): boolean
  foundVertical(): boolean
  // The element the click snapped onto: a vertex ref for a point snap, an entity
  // ref for a path snap, null for an axis snap, which names no second element.
  getSnappedElement(): string | null
  // The resolved snap itself, for a caller that would rather branch once.
  current(): InsertSnap | null
}

export function createInsertionHelper(geo: SketchGeometry = {}): InsertionHelper {
  let snapped: InsertSnap | null = null
  let point: [number, number] = [0, 0]
  return {
    update(snap, rawPoint) {
      snapped = resolveInsertSnap(snap, rawPoint, geo)
      point = resolveSnapPoint(rawPoint, snap, snapped)
    },
    getPoint: () => point,
    foundSnappablePoint: () => snapped?.kind === 'coincident',
    foundSnappablePath: () => snapped?.kind === 'point_on_path',
    foundHorizontal: () => snapped?.kind === 'horizontal',
    foundVertical: () => snapped?.kind === 'vertical',
    getSnappedElement: () => {
      if (snapped?.kind === 'coincident') return snapped.vertexId
      if (snapped?.kind === 'point_on_path') return snapped.entityRef
      return null
    },
    current: () => snapped,
  }
}

/** Resolve the effective click position from snap state.
 *  Priority: the vertex or curve the resolved snap names, else the alignment
 *  axis, else the raw cursor. The resolved snap is passed in so the position and
 *  the constraint can never disagree about what the click landed on; without it
 *  the historical standalone priority (alignment, then a published vertex
 *  position) still applies. */
export function resolveSnapPoint(
  rawPoint: readonly [number, number],
  snap: DrawSnapState,
  resolved: InsertSnap | null = null,
): [number, number] {
  if (resolved?.kind === 'coincident' || resolved?.kind === 'point_on_path') return resolved.at
  if (snap.alignmentSnapPoint && snap.alignmentSnapKind) {
    if (snap.alignmentSnapKind === 'kinda_horizontal') {
      return [rawPoint[0], snap.alignmentSnapPoint[1]]
    }
    return [snap.alignmentSnapPoint[0], rawPoint[1]]
  }
  if (snap.hoveredVertexPosition) return snap.hoveredVertexPosition
  return [rawPoint[0], rawPoint[1]]
}

/** Pin the inserted entity's vertex to the element the click landed on. The
 *  element may be a vertex (a point pair) or a whole entity (the locus form
 *  that keeps the point on that curve); both are the same `coincident` to the
 *  solver, so one inserter covers them. A null element, or a target with no
 *  vertex of its own, authors nothing. */
export function insertCoincidentPoint(
  snappedElement: string | null,
  target: InsertTarget,
): Mutation[] {
  if (!snappedElement || !target.vertexRef) return []
  return [{ type: 'add_constraint', featureId: target.featureId, kind: 'coincident',
    targets: [target.vertexRef, snappedElement] }]
}

/** An axis alignment describes the whole entity, so it takes the single-target
 *  form of horizontal/vertical and names no second element. */
export function insertAxisConstraint(
  kind: 'horizontal' | 'vertical',
  target: InsertTarget,
): Mutation[] {
  if (!target.entityRef) return []
  return [{ type: 'add_constraint', featureId: target.featureId, kind,
    targets: [target.entityRef] }]
}

/** The `add_entity_with_constraint` fields for a snap carried from an earlier
 *  click. The ref's own prefix says which kind it is, so a carried snap needs no
 *  second slot to remember whether it named a vertex or a curve. */
export function carriedSnapFields(
  ref: string,
): { snapVertexId?: string; snapEntityRef?: string } {
  return ref.startsWith('entity:') ? { snapEntityRef: ref } : { snapVertexId: ref }
}
