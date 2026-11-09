import type { PartDoc, PartFeature } from '@/types/cad'
import {
  warn, round, allFinite, resolveSketch, findSketchFeature, freshEntityIds, mintEntityId,
  uniqueConstraintId, parseTarget,
} from './helpers'
import type { SketchLists } from './helpers'
import { applyAddConstraint } from './sketch'
import {
  offsetCorners, coordinateCorners, uniqueCorners, lineIntersect, lineVertexIndices,
  vertexPoint, tangentCorner, lineCircleIntersect, circleCircleIntersect, nearestPoint,
  arcAngleKeepsSweep, snapTangentJoint,
} from '@/utils/geometry/offsetProfile'
import type { OffsetCorner } from '@/utils/geometry/offsetProfile'
import { offsetSidePlan } from '@/utils/geometry/offsetSide'
import { isProperRect, centerRectCorners } from '@/utils/geometry/rectGeometry'
import { circumcircle, arcEndpointOrder } from '@/utils/geometry/arcFromPoints'
import { SNAP_EPS } from '@/utils/geometry/snapTolerance'
import { sameSnapVertex } from '@/utils/snapRefs'

/** Check an author-supplied id block against the sketch. Returns the ids, or
 *  null after a warn when the block is the wrong length, holds a duplicate or
 *  carries an id the sketch already uses. The drive boundary refuses the same
 *  shape by name; this is the backstop for a direct dispatch, which must not
 *  write a half-authored document. */
function _authoredEntityIds(
  doc: PartDoc,
  featureId: string,
  ids: readonly string[],
  expected: number,
  what: string,
): string[] | null {
  if (ids.length !== expected) {
    warn(`${what}: entityIds must hold ${expected} ids`, { got: ids.length })
    return null
  }
  if (ids.some(id => typeof id !== 'string' || id.length === 0)) {
    warn(`${what}: entityIds must be non-empty strings`, { ids })
    return null
  }
  // The id has to survive the ref grammar the catalog documents: `@sk/<id>`
  // splits on `/` and `entity:sk:<id>` on `:`, and whitespace breaks both.
  if (ids.some(id => /[/:\s]/.test(id))) {
    warn(`${what}: entityIds must be ref-safe (no "/", ":" or whitespace)`, { ids })
    return null
  }
  if (new Set(ids).size !== ids.length) {
    warn(`${what}: entityIds must not repeat an id`, { ids })
    return null
  }
  const feature = findSketchFeature(doc, featureId)
  const existing = (feature?.entities ?? []).map(e => e.id)
  // Entity and constraint ids share one reference namespace: a fixed or
  // dimension could not be told apart from the new entity by a bare id.
  const existingConstraints = (feature?.constraints ?? []).map(c => c.id)
  const taken = ids.find(id => existing.includes(id) || existingConstraints.includes(id))
  if (taken !== undefined) {
    warn(`${what}: entity id already exists in the sketch`, { id: taken })
    return null
  }
  return [...ids]
}

/** Helper: add 4 rectangle lines with corner/edge/dimension constraints.
 *  Returns the 4 line IDs [lA, lB, lC, lD] for use in additional constraints.
 *  `entityIds`, when given, authors that block instead of minting one.
 */
function _applyRectLines(
  // Only the two containers this body indexes. The corner constraints go through
  // applyAddConstraint, which materializes `constraints` itself.
  feature: PartFeature & Pick<SketchLists, 'entities' | 'initial'>,
  featureId: string,
  doc: PartDoc,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  entityIds?: readonly string[],
): [string, string, string, string] {
  const [lA, lB, lC, lD] = entityIds ?? freshEntityIds(feature.entities, 4)
  const fid = featureId

  const lines: [string, number[]][] = [
    [lA, [x0, y0, x1, y0]],
    [lB, [x1, y0, x1, y1]],
    [lC, [x1, y1, x0, y1]],
    [lD, [x0, y1, x0, y0]],
  ]
  for (const [eid, params] of lines) {
    feature.entities.push({ id: eid, kind: 'line' })
    feature.initial[eid] = params.map(round)
  }

  applyAddConstraint(doc, fid, 'coincident',   [`vertex:${fid}:${lA}:end`,  `vertex:${fid}:${lB}:start`])
  applyAddConstraint(doc, fid, 'coincident',   [`vertex:${fid}:${lB}:end`,  `vertex:${fid}:${lC}:start`])
  applyAddConstraint(doc, fid, 'coincident',   [`vertex:${fid}:${lC}:end`,  `vertex:${fid}:${lD}:start`])
  applyAddConstraint(doc, fid, 'coincident',   [`vertex:${fid}:${lD}:end`,  `vertex:${fid}:${lA}:start`])
  applyAddConstraint(doc, fid, 'equal_length', [`entity:${fid}:${lA}`,      `entity:${fid}:${lC}`])
  applyAddConstraint(doc, fid, 'equal_length', [`entity:${fid}:${lB}`,      `entity:${fid}:${lD}`])
  applyAddConstraint(doc, fid, 'horizontal',   [`entity:${fid}:${lA}`])
  applyAddConstraint(doc, fid, 'vertical',     [`entity:${fid}:${lB}`])

  return [lA, lB, lC, lD]
}

/** Pin the sugar entity's own vertices to what the draw clicks snapped onto,
 *  in click order. Each ref is a `vertex:` ref (a point pair) or an `entity:`
 *  ref (the locus form, a point on that curve); both are one `coincident`. Two
 *  clicks on the same vertex say one thing, so only the first is authored; two
 *  clicks on the same curve are two points on it and both are pinned. Same
 *  rule (`sameSnapVertex`) as the line/arc/spline tools apply to their ends. */
function _pinSnappedVertices(
  doc: PartDoc,
  featureId: string,
  pins: [vertexRef: string, snapRef: string | null | undefined][],
): void {
  const pinned: string[] = []
  for (const [vertexRef, snapRef] of pins) {
    if (!snapRef || pinned.some(p => sameSnapVertex(p, snapRef))) continue
    pinned.push(snapRef)
    applyAddConstraint(doc, featureId, 'coincident', [vertexRef, snapRef])
  }
}

export function applyAddRect(
  doc: PartDoc,
  featureId: string,
  p0: [number, number],
  p1: [number, number],
  p0Ref?: string | null,
  p1Ref?: string | null,
  entityIds?: readonly string[],
): void {
  const [x0, y0] = p0
  const [x1, y1] = p1
  // The draw tool refuses a degenerate second click itself; this is the
  // backstop for any other caller. Bail before anything, even container
  // materialization, touches the document.
  if (!isProperRect(x0, y0, x1, y1)) {
    warn('applyAddRect: degenerate rectangle skipped', { p0, p1 })
    return
  }
  const authored = entityIds === undefined
    ? undefined
    : _authoredEntityIds(doc, featureId, entityIds, 4, 'applyAddRect')
  if (authored === null) return
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

  // _applyRectLines starts lA at (x0, y0) and lC at the diagonal (x1, y1).
  const [lA, , lC] = _applyRectLines(feature, featureId, doc, x0, y0, x1, y1, authored)
  _pinSnappedVertices(doc, featureId, [
    [`vertex:${featureId}:${lA}:start`, p0Ref],
    [`vertex:${featureId}:${lC}:start`, p1Ref],
  ])
}

export function applyAddCenterRect(
  doc: PartDoc,
  featureId: string,
  center: [number, number],
  corner: [number, number],
  centerRef?: string | null,
  cornerRef?: string | null,
  entityIds?: readonly string[],
): void {
  const [cx, cy] = center
  // 4 corners of the rectangle (symmetric around center); (x1, y1) is the click.
  const [x0, y0, x1, y1] = centerRectCorners(center, corner)
  // Same guard as applyAddRect, on the derived corners so one collapsed axis is
  // caught too; here it must also keep the center point and its diagonal
  // midpoint constraint from being authored.
  if (!isProperRect(x0, y0, x1, y1)) {
    warn('applyAddCenterRect: degenerate rectangle skipped', { center, corner })
    return
  }
  // Four lines then the centre point: the block the catalog documents.
  const authored = entityIds === undefined
    ? undefined
    : _authoredEntityIds(doc, featureId, entityIds, 5, 'applyAddCenterRect')
  if (authored === null) return
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

  const [lA, , lC] = _applyRectLines(feature, featureId, doc, x0, y0, x1, y1, authored?.slice(0, 4))

  // Create point entity at center
  const pointId = authored?.[4] ?? mintEntityId(feature.entities)
  feature.entities.push({ id: pointId, kind: 'point' })
  feature.initial[pointId] = [cx, cy].map(round)

  // The center point is the midpoint of ONE diagonal. On the drawn branch the
  // rect lines make a parallelogram, whose diagonals bisect each other, so a midpoint on
  // the second diagonal adds nothing and the solver flags it redundant (it
  // landed already "broken"). Which corner is "top" or "left" depends on where
  // the user clicked, so the corners are named by the click: lA:start is
  // (x0, y0), the mirror of the click through center; lC:start is (x1, y1).
  applyAddConstraint(doc, featureId, 'midpoint', [
    `vertex:${featureId}:${lA}:start`,
    `vertex:${featureId}:${lC}:start`,
    `vertex:${featureId}:${pointId}:xy`,
  ])

  // The clicked corner is (x1, y1), where lC starts.
  _pinSnappedVertices(doc, featureId, [
    [`vertex:${featureId}:${pointId}:xy`, centerRef],
    [`vertex:${featureId}:${lC}:start`, cornerRef],
  ])
}

/** N-gon sugar: N line entities forming a closed coincident chain, a
 *  construction circumcircle, and a single `ngon` regularity constraint. The
 *  lines store the circumscribed polygon (vertices on the circumcircle through
 *  `corner`); the circle's center is the polygon's center vertex and its radius
 *  the circumradius, both dimensionable. The `ngon` constraint is expanded at
 *  solve time to equal-length + angle primitives plus the vertex-on-circle
 *  coupling, so the solver never sees a real `ngon` kind. */
export function applyAddNgon(
  doc: PartDoc,
  featureId: string,
  center: [number, number],
  corner: [number, number],
  sides: number,
  cornerRef?: string | null,
  centerRef?: string | null,
  entityIds?: readonly string[],
): void {
  const n = Math.max(3, Math.floor(sides))
  const [cx, cy] = center
  const [vx, vy] = corner
  // A non-finite center, corner, or side count is broken pointer math upstream.
  // round(NaN) is still NaN, so a bad corner would seed NaN vertices for every
  // side, and a NaN side count collapses the push loop. Refuse before anything
  // is authored, so no orphan `ngon` constraint is left behind with no lines.
  if (!allFinite([cx, cy, vx, vy]) || !Number.isFinite(sides)) {
    warn('applyAddNgon: ignoring non-finite geometry', { featureId, center, corner, sides })
    return
  }
  const radius = Math.hypot(vx - cx, vy - cy)
  if (radius <= 0) return  // degenerate: a point, not a polygon

  // n lines then the construction circumcircle: the block the catalog documents.
  const authored = entityIds === undefined
    ? undefined
    : _authoredEntityIds(doc, featureId, entityIds, n + 1, 'applyAddNgon')
  if (authored === null) return
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

  const angle0 = Math.atan2(vy - cy, vx - cx)
  const lineIds = authored?.slice(0, n) ?? freshEntityIds(feature.entities, n)
  for (let i = 0; i < n; i++) {
    const id = lineIds[i]
    const a1 = angle0 + (i / n) * 2 * Math.PI
    const a2 = angle0 + ((i + 1) / n) * 2 * Math.PI
    feature.entities.push({ id, kind: 'line' })
    feature.initial[id] = [
      cx + radius * Math.cos(a1), cy + radius * Math.sin(a1),
      cx + radius * Math.cos(a2), cy + radius * Math.sin(a2),
    ].map(round)
  }

  // Closed coincident chain: each line's end meets the next line's start.
  for (let i = 0; i < n; i++) {
    applyAddConstraint(doc, featureId, 'coincident', [
      `vertex:${featureId}:${lineIds[i]}:end`,
      `vertex:${featureId}:${lineIds[(i + 1) % n]}:start`,
    ])
  }

  // The circumcircle carries the n-gon's center. Construction, so it never
  // becomes profile geometry.
  const circleId = authored?.[n] ?? mintEntityId(feature.entities)
  feature.entities.push({ id: circleId, kind: 'circle', construction: true })
  feature.initial[circleId] = [cx, cy, radius].map(round)

  // The single regularity constraint, which also owns the circle coupling.
  // Deleting it "breaks" the n-gon: the closed line chain becomes an editable
  // irregular polygon and the circle a free construction circle.
  const cid = uniqueConstraintId(feature.constraints, 'ngon')
  feature.constraints.push({
    id: cid,
    kind: 'ngon',
    refs: lineIds.map(eid => parseTarget(`entity:${featureId}:${eid}`, featureId)),
    circle: parseTarget(`entity:${featureId}:${circleId}`, featureId),
  })

  // Click order: the center click first, then the corner, where the first line
  // starts (angle0).
  _pinSnappedVertices(doc, featureId, [
    [`vertex:${featureId}:${circleId}:center`, centerRef],
    [`vertex:${featureId}:${lineIds[0]}:start`, cornerRef],
  ])
}

/** Which stored arc vertex key holds each given point of a three-point arc.
 *
 *  The arc is stored counter-clockwise, so a through point that sends
 *  start -> through -> end clockwise makes the given start the stored `end`
 *  and the given end the stored `start`. The reply names this so a caller can
 *  write `vertex:<sketch>:<arc>:<key>` without guessing. */
export function threePointArcVertexKeys(
  start: [number, number],
  through: [number, number],
  end: [number, number],
): { start: 'start' | 'end'; end: 'start' | 'end' } | null {
  const cc = circumcircle(start, end, through)
  if (!cc) return null
  const { startsAtFirst } = arcEndpointOrder(cc.cx, cc.cy, start, end, through)
  return startsAtFirst ? { start: 'start', end: 'end' } : { start: 'end', end: 'start' }
}

/** Three-point arc sugar: the arc the app's draw tool makes, in CadQuery's
 *  `threePointArc(start, through, end)` order (a point ON the arc sits between
 *  its two ends). The tool's click order is start, end, bulge, so its third
 *  click is `through`.
 *
 *  The stored arc is CCW from a0_deg to a1_deg, so the through point decides
 *  which authored end becomes the stored `start` vertex; a ref is pinned to the
 *  vertex its own point occupies, never to the click order. Without refs the
 *  stored circle and angles are rounded to the document grid, so the ends land
 *  within about 1e-6 of the given points: inside the 1e-5 loop closure, but
 *  not constrained to a neighbour. */
export function applyAddThreePointArc(
  doc: PartDoc,
  featureId: string,
  start: [number, number],
  through: [number, number],
  end: [number, number],
  startRef?: string | null,
  endRef?: string | null,
  entityId?: string,
): void {
  // Same gate as applyAddNgon: round(NaN) is still NaN, so a non-finite point
  // would seed a poisoned arc that every later solve reads.
  if (!allFinite([...start, ...through, ...end])) {
    warn('applyAddThreePointArc: ignoring non-finite points', { featureId, start, through, end })
    return
  }
  // The draw tool's own "same point" tolerance, so a pair of clicks it would
  // have collapsed is refused by the same measure here. Which pair failed is
  // named: the caller can only fix the one it sent.
  const coincide = (a: [number, number], b: [number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]) <= SNAP_EPS
  const coincidence = coincide(start, end)
    ? 'start and end'
    : coincide(start, through)
      ? 'start and through'
      : coincide(through, end) ? 'through and end' : null
  if (coincidence !== null) {
    const advice = coincidence === 'start and end' ? 'use a circle' : 'an arc needs three distinct points'
    warn(`applyAddThreePointArc: ${coincidence} coincide; ${advice}`, { start, through, end })
    return
  }
  const cc = circumcircle(start, end, through)
  if (!cc) {
    warn('applyAddThreePointArc: start, through and end are collinear; an arc needs a bend, use a line',
      { start, through, end })
    return
  }
  const authored = entityId === undefined
    ? undefined
    : _authoredEntityIds(doc, featureId, [entityId], 1, 'applyAddThreePointArc')
  if (authored === null) return
  const feature = resolveSketch(doc, featureId, 'entities', 'initial')
  if (!feature) return

  // A through point beyond the chord picks the major arc (a sweep over 180).
  const { angles: [aStart, aEnd], startsAtFirst } = arcEndpointOrder(cc.cx, cc.cy, start, end, through)
  const arcId = authored?.[0] ?? mintEntityId(feature.entities)
  feature.entities.push({ id: arcId, kind: 'arc' })
  feature.initial[arcId] = [cc.cx, cc.cy, cc.r, aStart, aEnd].map(round)

  // The authored start sits on the stored `end` vertex when the order ran
  // clockwise; its ref follows the point, not the key.
  const [startKey, endKey] = startsAtFirst ? ['start', 'end'] : ['end', 'start']
  _pinSnappedVertices(doc, featureId, [
    [`vertex:${featureId}:${arcId}:${startKey}`, startRef],
    [`vertex:${featureId}:${arcId}:${endKey}`, endRef],
  ])
}

/** Compute the offset seed params for a cloned entity: the source geometry moved
 *  by `distance`, with the sign selecting the side. Returns null for a degenerate
 *  source (a zero-length line) that has no well-defined normal.
 *
 *  Seed rule (locked by tests so a refactor cannot silently flip it): a
 *  positive `distance` moves a line along the LEFT normal of its start->end
 *  direction `(-dy, dx)/L`, and grows the radius of a circle/arc. This is the
 *  per-entity rule a branching open selection, or a lone entity, uses;
 *  applyAddOffset corrects the sign per entity for a selection that closes into
 *  loops (positive out of the region) or forms an open chain (positive to the
 *  left of the chain walk) in geometry/offsetSide.ts.
 *  Spline/ellipse have no clean parametric offset, so the seed is an exact copy.
 *  Shared with the connected-profile offset so both author identical seeds. */
function offsetSeed(kind: string, p: number[], distance: number): number[] | null {
  switch (kind) {
    case 'line': {
      const dx = p[2] - p[0], dy = p[3] - p[1]
      const L = Math.hypot(dx, dy)
      if (L < 1e-9) return null  // no direction, hence no normal: caller skips it
      const nx = -dy / L, ny = dx / L
      return [p[0] + distance * nx, p[1] + distance * ny,
              p[2] + distance * nx, p[3] + distance * ny]
    }
    case 'circle':
      return [p[0], p[1], Math.max(1e-6, p[2] + distance)]
    case 'arc':
      return [p[0], p[1], Math.max(1e-6, p[2] + distance), p[3], p[4]]
    default:
      return [...p]  // spline / ellipse: copy at source
  }
}

/** Miter a sharp line/arc or arc/arc corner on the offset CURVES themselves.
 *  The clone's OWN seeded params are the truth: `offsetSeed` already applied the
 *  per-entity side factor, so a closed loop can shrink a convex arc (the heart's
 *  r40 clone is r38) while a concave arc grows; recomputing `r + distance` would
 *  miter against a circle the clone does not sit on. The clone line is its seeded
 *  line and the clone arc is its seeded circle, exactly the same untrimmed seed
 *  the line/line arm uses. */
function miterCurvedCorner(
  doc: PartDoc,
  featureId: string,
  initial: Record<string, number[]>,
  sourceA: string,
  sourceB: string,
  cloneA: string,
  cloneB: string,
  kindA: string,
  kindB: string,
  corner: OffsetCorner,
  seedSnapshot: ReadonlyMap<string, number[]>,
): void {
  const seedA = seedSnapshot.get(cloneA)
  const seedB = seedSnapshot.get(cloneB)
  if (!seedA || !seedB) return

  // The miter is chosen nearest the authored joint, so the far root of a pair of
  // intersecting circles cannot become the corner.
  const jointA = vertexPoint(kindA, initial[sourceA] ?? [], corner.a.vertexKey)
  const jointB = vertexPoint(kindB, initial[sourceB] ?? [], corner.b.vertexKey)
  if (!jointA && !jointB) return
  const joint: [number, number] = jointA && jointB
    ? [(jointA[0] + jointB[0]) / 2, (jointA[1] + jointB[1]) / 2]
    : (jointA ?? jointB)!

  let roots: Array<[number, number]>
  if (kindA === 'arc' && kindB === 'arc') {
    roots = circleCircleIntersect(seedA[0], seedA[1], seedA[2], seedB[0], seedB[1], seedB[2])
  } else if (kindA === 'line' && kindB === 'line') {
    return  // the line/line arm owns this corner; not reachable from the dispatcher
  } else if (kindA === 'line') {
    roots = lineCircleIntersect(seedA, seedB[0], seedB[1], seedB[2])
  } else {
    roots = lineCircleIntersect(seedB, seedA[0], seedA[1], seedA[2])
  }
  const miter = nearestPoint(roots, joint)
  if (!miter) return  // offset curves miss: leave the gap, never fall back to tangent

  const point: [number, number] = [round(miter[0]), round(miter[1])]
  const sides = [
    { kind: kindA, seed: seedA, cloneId: cloneA, vertexKey: corner.a.vertexKey },
    { kind: kindB, seed: seedB, cloneId: cloneB, vertexKey: corner.b.vertexKey },
  ]
  // Validate every write before touching either clone: a joint whose miter would
  // cross an arc's other end has to stay entirely ungrafted, not half trimmed.
  const lineWrites: Array<{ cloneId: string; ix: number; iy: number }> = []
  const arcWrites: Array<{ cloneId: string; index: number; deg: number }> = []
  for (const side of sides) {
    if (side.kind === 'line') {
      const indices = lineVertexIndices(side.vertexKey)
      if (!indices) return
      lineWrites.push({ cloneId: side.cloneId, ix: indices[0], iy: indices[1] })
      continue
    }
    if (side.vertexKey !== 'start' && side.vertexKey !== 'end') return
    // The arc's other endpoint may already have been mitred for its own corner,
    // so the sweep check reads the CURRENT angles while the circle geometry
    // (centre, radius) comes from the untrimmed seed.
    const current = initial[side.cloneId]
    const deg = (Math.atan2(point[1] - side.seed[1], point[0] - side.seed[0]) * 180) / Math.PI
    if (!arcAngleKeepsSweep(current[3], current[4], deg, side.vertexKey)) return
    arcWrites.push({ cloneId: side.cloneId, index: side.vertexKey === 'start' ? 3 : 4, deg })
  }

  for (const write of lineWrites) {
    const params = initial[write.cloneId]
    params[write.ix] = point[0]
    params[write.iy] = point[1]
  }
  for (const write of arcWrites) initial[write.cloneId][write.index] = round(write.deg)
  applyAddConstraint(doc, featureId, 'coincident', [
    `vertex:${featureId}:${cloneA}:${corner.a.vertexKey}`,
    `vertex:${featureId}:${cloneB}:${corner.b.vertexKey}`,
  ])
}

/** Reconnect the corners among offset clones: miter sharp corners on the two
 *  *seeded* (untrimmed) offset curves (NOT the offset of the shared vertex), and
 *  carry a genuinely tangent joint over as a `coincident` on the two clone
 *  vertices plus a `tangent` on the two curves. A corner is either an explicit
 *  `coincident` or two selected endpoints the area builder welds by coordinate
 *  (a hand-drawn chain), so both authoring styles rebuild the same joint.
 *  Snapshot the seeds before trimming endpoints -- otherwise the second corner
 *  of a shared line would intersect an already-moved line and drift.
 *  Spline/ellipse corners stay ungrafted (matches the copy-at-source clone
 *  policy). */
function reconnectOffsetCorners(
  doc: PartDoc,
  feature: PartFeature & Pick<SketchLists, 'entities' | 'initial' | 'constraints'>,
  featureId: string,
  cloneOf: Map<string, string>,
  kindOf: Map<string, string>,
): void {
  const initial = feature.initial
  const seedSnapshot = new Map<string, number[]>()
  for (const cloneId of cloneOf.values()) seedSnapshot.set(cloneId, [...initial[cloneId]])

  const sourceIds = [...cloneOf.keys()]
  // A rectangle has both forms of join (coincidents and equal coordinates), so
  // the merge keeps the explicit-corner ordering while dropping the duplicate.
  const corners = uniqueCorners([
    ...offsetCorners(sourceIds, feature.constraints),
    ...coordinateCorners(feature.entities, initial, sourceIds),
  ])
  for (const corner of corners) {
    const cloneA = cloneOf.get(corner.a.entityId)
    const cloneB = cloneOf.get(corner.b.entityId)
    if (!cloneA || !cloneB) continue
    const kindA = kindOf.get(corner.a.entityId)
    const kindB = kindOf.get(corner.b.entityId)

    if (kindA === 'line' && kindB === 'line') {
      const ix = lineIntersect(seedSnapshot.get(cloneA)!, seedSnapshot.get(cloneB)!)
      if (!ix) continue  // near-parallel: leave the gap, no coincident, no crash
      const ia = lineVertexIndices(corner.a.vertexKey)
      const ib = lineVertexIndices(corner.b.vertexKey)
      if (!ia || !ib) continue
      const pa = initial[cloneA], pb = initial[cloneB]
      pa[ia[0]] = round(ix[0]); pa[ia[1]] = round(ix[1])
      pb[ib[0]] = round(ix[0]); pb[ib[1]] = round(ix[1])
      applyAddConstraint(doc, featureId, 'coincident', [
        `vertex:${featureId}:${cloneA}:${corner.a.vertexKey}`,
        `vertex:${featureId}:${cloneB}:${corner.b.vertexKey}`,
      ])
    } else if ((kindA === 'line' || kindA === 'arc') && (kindB === 'line' || kindB === 'arc')) {
      // LINE/ARC or ARC/ARC. The SOURCE joint's tangents decide the join, never
      // the kind alone: a `tangent` at a sharp joint is false, and because the
      // clones are tied to their sources the solver satisfies it by moving
      // them. A tangent joint is snapped so the two clone ends start at one
      // point and is declared as a `coincident` plus a `tangent`: the seeds
      // already satisfy both, so the solver has a contact to hold rather than
      // an implied meeting it may let open. A sharp one is sealed at the
      // offset-curve intersection.
      const paramsA = initial[corner.a.entityId]
      const paramsB = initial[corner.b.entityId]
      const tangent = paramsA && paramsB && tangentCorner(
        { kind: kindA!, params: paramsA, vertexKey: corner.a.vertexKey },
        { kind: kindB!, params: paramsB, vertexKey: corner.b.vertexKey },
      )
      if (tangent) {
        // A `tangent` alone only says the two curves meet tangentially: it does
        // not declare that their endpoints touch, so a solve that moves one a
        // hair leaves a gap and the area builder (which merges at the absolute
        // grid) then finds no closed loop. Pin the two clone vertices together
        // first, after snapping the free line end onto the anchored arc end, so
        // the contact is declared at the seed and the solver holds it as one;
        // the fillet path writes the same pair in the same order.
        snapTangentJoint(initial,
          { cloneId: cloneA, kind: kindA!, vertexKey: corner.a.vertexKey },
          { cloneId: cloneB, kind: kindB!, vertexKey: corner.b.vertexKey })
        applyAddConstraint(doc, featureId, 'coincident', [
          `vertex:${featureId}:${cloneA}:${corner.a.vertexKey}`,
          `vertex:${featureId}:${cloneB}:${corner.b.vertexKey}`,
        ])
        applyAddConstraint(doc, featureId, 'tangent', [
          `entity:${featureId}:${cloneA}`,
          `entity:${featureId}:${cloneB}`,
        ])
      } else {
        miterCurvedCorner(doc, featureId, initial, corner.a.entityId, corner.b.entityId,
          cloneA, cloneB, kindA!, kindB!, corner, seedSnapshot)
      }
    }
    // A circle has no endpoint vertex: its corner is only reachable through an
    // explicit `coincident` on its centre, which a miter cannot rebuild, so it
    // is skipped outright (no tangent, no coincident). Spline/ellipse corners
    // also stay ungrafted (matches the copy-at-source clone policy above).
  }
}

/** Offset: for each source entity, clone it and tie the copy to the source with
 *  ONLY a geometric relationship (parallel for lines, concentric for
 *  circles/arcs). The offset distance and direction are baked into the clone's
 *  initial geometry via `offsetSeed`, NOT stored as a dimension. The result is
 *  intentionally under-constrained: the clone holds its seeded position because
 *  nothing drives it, and the user dimensions it afterward if they want it
 *  driven. Authoring zero dimensions is deliberate -- offsetting a multi-line
 *  profile must not spray a dimension per entity, and baking the side into the
 *  seed removes the solver's freedom to flip the offset to the wrong side.
 *  Splines/ellipses have no clean offset, so only the (at-source) copy is made.
 *
 *  Connectivity carry-over: a *connected* selection (rectangle, n-gon, fillet
 *  chain, or a hand-drawn chain whose endpoints merely meet by coordinate) is
 *  held together at its corners. Offsetting each entity in isolation would tear
 *  those corners apart, so after cloning we rebuild every corner among the
 *  selected sources on the clones. A joint whose SOURCE tangents are already
 *  aligned keeps a `coincident` between the two clone vertices plus a `tangent`
 *  between the curves, the pair fillet_corners writes at its joints; every other
 *  line/arc and arc/arc joint is sealed at the intersection of the two offset
 *  curves (never the offset of the shared vertex), and line/line stays the
 *  plain miter. Still no dimensions; the reconnection is the only added
 *  structure. */
export function applyAddOffset(
  doc: PartDoc,
  featureId: string,
  sourceIds: string[],
  distance: number,
): void {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return
  // Every clone's seed is stored at the document's number precision. round(NaN)
  // is still NaN, so a non-finite distance would seed NaN clones (plus their
  // miter reconnections) across the whole selection.
  if (!Number.isFinite(distance)) {
    warn('applyAddOffset: ignoring non-finite distance', { featureId, sourceIds, distance })
    return
  }

  const cloneOf = new Map<string, string>()  // source id -> clone id
  const kindOf = new Map<string, string>()   // source id -> entity kind

  // A selection that closes into loops offsets by side, not by seed rule:
  // positive is out of the bounded region whatever each entity's direction. An
  // open chain follows its walk; a branch has no single walk, so it keeps the
  // per-entity rule and the user is told the side is per entity.
  const sources = sourceIds.flatMap((id) => {
    const entity = feature.entities.find(e => e.id === id)
    const params = feature.initial[id]
    return entity && params ? [{ id, kind: entity.kind, params }] : []
  })
  const sidePlan = offsetSidePlan(sources, feature.constraints ?? [])
  if (sidePlan.branches) {
    warn('applyAddOffset: selection branches, keeping the per-entity side for every copy',
      { featureId, sourceIds })
  }
  const sideFactor = sidePlan.factors

  for (const srcId of sourceIds) {
    const src = feature.entities.find(e => e.id === srcId)
    const srcParams = feature.initial[srcId]
    if (!src || !srcParams) continue

    const seed = offsetSeed(src.kind, srcParams, distance * (sideFactor.get(srcId) ?? 1))
    if (!seed) continue  // degenerate source: no offset direction

    // Each clone is pushed before the next id is drawn, so reading the live list
    // is what keeps the run collision-free.
    const dstId = mintEntityId(feature.entities)
    // A fit_spline's handles field is part of its layout, so the at-source
    // copy must carry it or the cloned params read the handles as fit points.
    feature.entities.push({ id: dstId, kind: src.kind, ...(src.handles ? { handles: src.handles } : {}) })
    feature.initial[dstId] = seed.map(round)
    cloneOf.set(srcId, dstId)
    kindOf.set(srcId, src.kind)

    const srcRef = `entity:${featureId}:${srcId}`
    const dstRef = `entity:${featureId}:${dstId}`
    switch (src.kind) {
      case 'line':
        applyAddConstraint(doc, featureId, 'parallel', [srcRef, dstRef])
        break
      case 'circle':
      case 'arc':
        applyAddConstraint(doc, featureId, 'concentric', [srcRef, dstRef])
        break
      default:
        break  // spline / ellipse: copy only, no relationship
    }
  }

  // Reconnect the corners. Miter points are intersections of the *seeded*
  // (untrimmed) offset lines, so snapshot the seeds before we start trimming
  // endpoints -- otherwise the second corner of a shared line would intersect an
  // already-moved line and drift.
  reconnectOffsetCorners(doc, feature, featureId, cloneOf, kindOf)
}
