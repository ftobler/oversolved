import type { PartDoc, PartFeature } from '@/types/cad'
import {
  warn, round, allFinite, resolveSketch, freshEntityIds, mintEntityId,
  uniqueConstraintId, parseTarget,
} from './helpers'
import type { SketchLists } from './helpers'
import { applyAddConstraint } from './sketch'
import { offsetCorners, lineIntersect, lineVertexIndices } from '@/utils/geometry/offsetProfile'
import { isProperRect, centerRectCorners } from '@/utils/geometry/rectGeometry'
import { sameSnapVertex } from '@/utils/snapRefs'

/** Helper: add 4 rectangle lines with corner/edge/dimension constraints.
 *  Returns the 4 line IDs [lA, lB, lC, lD] for use in additional constraints.
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
): [string, string, string, string] {
  const [lA, lB, lC, lD] = freshEntityIds(feature.entities, 4)
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
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

  // _applyRectLines starts lA at (x0, y0) and lC at the diagonal (x1, y1).
  const [lA, , lC] = _applyRectLines(feature, featureId, doc, x0, y0, x1, y1)
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
): void {
  const [cx, cy] = center
  // 4 corners of the rectangle (symmetric around center); (x1, y1) is the click.
  const [x0, y0, x1, y1] = centerRectCorners(center, corner)
  // Same guard as applyAddRect, on the derived corners so one collapsed axis is
  // caught too; here it must also keep the center point and its two diagonal
  // midpoint constraints from being authored.
  if (!isProperRect(x0, y0, x1, y1)) {
    warn('applyAddCenterRect: degenerate rectangle skipped', { center, corner })
    return
  }
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

  const [lA, lB, lC, lD] = _applyRectLines(feature, featureId, doc, x0, y0, x1, y1)

  // Create point entity at center
  const pointId = mintEntityId(feature.entities)
  feature.entities.push({ id: pointId, kind: 'point' })
  feature.initial[pointId] = [cx, cy].map(round)

  // The center point is the midpoint of each diagonal. Which corner is "top" or
  // "left" depends on where the user clicked, so the corners are named by the
  // click: (x1, y1) is the clicked corner, (x0, y0) its mirror through center.
  // Diagonal 1: lA:start (x0, y0, the mirror) to lC:start (x1, y1, the click)
  applyAddConstraint(doc, featureId, 'midpoint', [
    `vertex:${featureId}:${lA}:start`,
    `vertex:${featureId}:${lC}:start`,
    `vertex:${featureId}:${pointId}:xy`,
  ])
  // Diagonal 2: lB:start (x1, y0) to lD:start (x0, y1)
  applyAddConstraint(doc, featureId, 'midpoint', [
    `vertex:${featureId}:${lB}:start`,
    `vertex:${featureId}:${lD}:start`,
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
): void {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return

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
  const angle0 = Math.atan2(vy - cy, vx - cx)

  const lineIds = freshEntityIds(feature.entities, n)
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
  const circleId = mintEntityId(feature.entities)
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

/** Compute the offset seed params for a cloned entity: the source geometry moved
 *  by `distance`, with the sign selecting the side. Returns null for a degenerate
 *  source (a zero-length line) that has no well-defined normal.
 *
 *  Sign convention (locked by tests so a refactor cannot silently flip it): a
 *  positive `distance` moves a line along the LEFT normal of its start->end
 *  direction `(-dy, dx)/L`, and grows the radius of a circle/arc (outward).
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

/** Reconnect the corners among offset clones: miter line/line corners to the
 *  intersection of the two *seeded* (untrimmed) offset lines (NOT the offset of
 *  the shared vertex), and carry line/arc and arc/arc tangency over so the
 *  solver settles the fillet join. Snapshot the seeds before trimming endpoints
 *  -- otherwise the second corner of a shared line would intersect an
 *  already-moved line and drift. Spline/ellipse corners stay ungrafted (matches
 *  the copy-at-source clone policy). */
function reconnectOffsetCorners(
  doc: PartDoc,
  feature: PartFeature & Pick<SketchLists, 'initial' | 'constraints'>,
  featureId: string,
  cloneOf: Map<string, string>,
  kindOf: Map<string, string>,
): void {
  const initial = feature.initial
  const seedSnapshot = new Map<string, number[]>()
  for (const cloneId of cloneOf.values()) seedSnapshot.set(cloneId, [...initial[cloneId]])

  const curved = (k: string | undefined) => k === 'arc' || k === 'circle'
  for (const corner of offsetCorners([...cloneOf.keys()], feature.constraints)) {
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
    } else if ((kindA === 'line' && curved(kindB)) || (curved(kindA) && kindB === 'line') ||
               (curved(kindA) && curved(kindB))) {
      // line/arc or arc/arc: a fillet corner. Endpoints of an arc clone cannot be
      // mitered into place (the geometry is center+radius+angles), so carry the
      // tangency over and let the solver settle the join.
      applyAddConstraint(doc, featureId, 'tangent', [
        `entity:${featureId}:${cloneA}`,
        `entity:${featureId}:${cloneB}`,
      ])
    }
    // spline/ellipse corners: no clean offset relationship, leave them ungrafted
    // (matches the copy-at-source clone policy above).
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
 *  chain) is held together by `coincident` corners. Offsetting each entity in
 *  isolation would tear those corners apart, so after cloning we rebuild every
 *  corner among the selected sources on the clones -- mitering line/line corners
 *  to the intersection of the two offset lines (NOT the offset of the shared
 *  vertex) and carrying line/arc tangency over with a `tangent`. Still no
 *  dimensions; the reconnection is the only added structure. */
export function applyAddOffset(
  doc: PartDoc,
  featureId: string,
  sourceIds: string[],
  distance: number,
): void {
  const feature = resolveSketch(doc, featureId, 'entities', 'initial', 'constraints')
  if (!feature) return
  // The distance is persisted verbatim into every clone's seed. round(NaN) is
  // still NaN, so a non-finite distance would seed NaN clones (plus their miter
  // reconnections) across the whole selection.
  if (!Number.isFinite(distance)) {
    warn('applyAddOffset: ignoring non-finite distance', { featureId, sourceIds, distance })
    return
  }

  const cloneOf = new Map<string, string>()  // source id -> clone id
  const kindOf = new Map<string, string>()   // source id -> entity kind

  for (const srcId of sourceIds) {
    const src = feature.entities.find(e => e.id === srcId)
    const srcParams = feature.initial[srcId]
    if (!src || !srcParams) continue

    const seed = offsetSeed(src.kind, srcParams, distance)
    if (!seed) continue  // degenerate source: no offset direction

    // Each clone is pushed before the next id is drawn, so reading the live list
    // is what keeps the run collision-free.
    const dstId = mintEntityId(feature.entities)
    feature.entities.push({ id: dstId, kind: src.kind })
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
