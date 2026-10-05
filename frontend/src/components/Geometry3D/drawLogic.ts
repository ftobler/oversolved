// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Mutation, Entity } from '@/types/cad'
import type { DrawSnapState, InsertTarget } from '@/components/Geometry3D/drawAutoConstraints'
import { createInsertionHelper, insertCoincidentPoint, insertAxisConstraint, carriedSnapFields, resolveSnapPoint, SNAP_EPS } from '@/components/Geometry3D/drawAutoConstraints'
import { getEntityKind } from '@/types/cad'
import { projectionMutationsForId } from '@/tools/projectionMutations'
import { circumcircle, arcEndpointOrder, ELLIPSE_MINOR_RATIO } from '@/components/Geometry3D/drawGeometry'
import { isFiniteSketchPoint } from '@/components/Geometry3D/pointerAbstraction'
import { isProperRect, centerRectCorners } from '@/utils/geometry/rectGeometry'
import { sameSnapVertex } from '@/utils/snapRefs'
import { failLoud } from '@/stores/stateInvariants'

export type { DrawSnapState }
export { resolveSnapPoint }

export interface DrawClickResult {
  mutations: Mutation[]
  /**
   * null  -- leave draw points unchanged
   * array -- replace draw points with this array (intermediate clicks, arc 2nd click)
   */
  nextDrawPoints: [number, number][] | null
  // null means leave the carried draw snaps unchanged; an object replaces them.
  // One ref per placed point, index-aligned with drawPoints, each naming either
  // a vertex or a whole entity (a point on that curve). A gesture whose entity
  // is created several clicks after a snapped point (the arc's two ends, the
  // spline's start) reads its own click's ref back out of this list.
  nextDrawSnap: { refs: (string | null)[] } | null
  // true when this click completed the gesture and produced its entity; the
  // adapter clears the draw buffer and consults the tool's
  // `staysArmedAfterCommit` policy to decide whether to keep the tool armed.
  gestureComplete: boolean
}

/** Pure draw click handler. Accepts all snap/draw state as plain data; has no store reads.
 *  newEntityIdFn is injected so tests can provide a deterministic ID instead of randomId(). */
export function computeDrawClick(
  tool: string,
  drawPoints: readonly [number, number][],
  rawPoint: readonly [number, number],
  snap: DrawSnapState,
  featureId: string,
  newEntityIdFn: () => string,
  // sketch and otherSketches are needed only for the 'project' tool.
  sketch?: Record<string, Entity>,
  otherSketches?: Record<string, Record<string, Entity>>,
): DrawClickResult {
  // One read of what is under the cursor, then every branch below just asks it
  // the questions its own entity can answer.
  const inserter = createInsertionHelper({ sketch, otherSketches })
  inserter.update(snap, rawPoint)
  const [px, py] = inserter.getPoint()
  const pts = drawPoints

  // The first click of a multi-click gesture records only WHAT it landed on;
  // the constraint is authored later, by the click that creates the entity. An
  // alignment snap has no meaning yet: there is no entity for an axis
  // constraint to describe.
  const clickedRef = (): string | null =>
    inserter.foundSnappablePoint() || inserter.foundSnappablePath()
      ? inserter.getSnappedElement()
      : null
  const startSnap = (): { refs: (string | null)[] } => ({ refs: [clickedRef()] })

  const nothing: DrawClickResult = { mutations: [], nextDrawPoints: null, nextDrawSnap: null, gestureComplete: false }

  // A closed curve sized by its second click (circle radius, ellipse major
  // axis) passes through the point that click landed on. Only a vertex snap
  // can say so in one constraint: the vertex lies on the new curve. A curve
  // under the cursor would need "passes through some point of that curve",
  // and an axis snap names no element, so both author nothing. A vertex the
  // centre is already pinned to cannot also lie on the curve.
  const onCurveThroughSnappedVertex = (curveId: string, centreRef: string | null): Mutation[] => {
    if (!inserter.foundSnappablePoint()) return []
    const vertexRef = inserter.getSnappedElement()
    if (!vertexRef || sameSnapVertex(vertexRef, centreRef)) return []
    return [{ type: 'add_constraint', featureId, kind: 'coincident',
      targets: [vertexRef, `entity:${featureId}:${curveId}`] }]
  }

  // Last gate before a number becomes a mutation. A snap source that published
  // a broken position (or a caller that skipped the abstraction layer) must not
  // be able to write NaN/Infinity into the document: fail loud and commit
  // nothing. The project prefers a dropped click over a poisoned sketch.
  if (!isFiniteSketchPoint([px, py])) {
    failLoud(`[computeDrawClick] ${tool}: non-finite resolved point [${px}, ${py}]; click dropped`)
    return nothing
  }

  const t: string = tool  // prevent type narrowing across branches
  if (t === 'point') {
    // A point dropped onto an existing vertex IS that vertex, and one dropped on
    // a curve lies on that curve; say so, rather than leaving a free point that
    // merely starts at the right coordinate. An alignment snap cannot be
    // expressed on a point entity, so that question is not asked here.
    const onElement = inserter.foundSnappablePoint() || inserter.foundSnappablePath()
      ? inserter.getSnappedElement()
      : null
    const mutation: Mutation = onElement
      ? { type: 'add_entity_with_constraint', featureId, kind: 'point', params: [px, py],
          vertexKey: 'xy', ...carriedSnapFields(onElement), constraintKind: 'coincident' }
      : { type: 'add_entity', featureId, kind: 'point', params: [px, py] }
    return {
      mutations: [mutation],
      nextDrawPoints: null,
      nextDrawSnap: null,
      gestureComplete: true,
    }
  }

  if (t === 'line') {
    if (pts.length === 0) {
      const drawSnap = startSnap()
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }

    // A polyline closes when the click lands back on the first vertex; the rest
    // of the chain then becomes a single closed loop. Closing decides the
    // segment's endpoint and ends the gesture, nothing more: the constraints
    // below are authored on the same path as any other segment, because a
    // closing click snaps to an old point exactly like every other click does.
    const startPoint = pts[0]
    const closesChain = pts.length >= 2 &&
      Math.abs(px - startPoint[0]) < SNAP_EPS &&
      Math.abs(py - startPoint[1]) < SNAP_EPS

    const segStart = pts[pts.length - 1]
    // Take the closing endpoint from the chain's own first point rather than the
    // resolved click, so a loop closes on the exact coordinate it opened at.
    const segEnd = closesChain ? startPoint : [px, py]
    // A click that resolves back onto the segment's own start (a double click on
    // the chain's end vertex, typically) would author a zero-length line nothing
    // can use. Drop the click and keep the chain where it was.
    if (Math.abs(segEnd[0] - segStart[0]) < SNAP_EPS && Math.abs(segEnd[1] - segStart[1]) < SNAP_EPS) {
      return nothing
    }

    const lineId = newEntityIdFn()
    const mutations: Mutation[] = []
    const startRef = snap.drawSnapRefs[pts.length - 1] ?? null
    const endRef = clickedRef()
    // Both ends pinned to the SAME vertex would make the solver pull the line to
    // zero length: drop the constraints and fall back to a free line so the
    // kernel does not silently discard it. Both ends on the same CURVE is a
    // chord, two independent point-on-curve statements, so both are authored.
    const sameVertex = sameSnapVertex(startRef, endRef)

    const params = [segStart[0], segStart[1], segEnd[0], segEnd[1]]

    if (startRef && !sameVertex) {
      mutations.push({ type: 'add_entity_with_constraint', featureId, kind: 'line',
        params, vertexKey: 'start',
        ...carriedSnapFields(startRef), constraintKind: 'coincident', entityId: lineId })
    } else {
      mutations.push({ type: 'add_entity', featureId, kind: 'line', params, entityId: lineId })
    }

    // Whatever the end click landed on is asked for once, here: the segment can
    // express a point pair on its own end vertex and an axis constraint on
    // itself, so it honours both questions the helper answers.
    const endTarget: InsertTarget = {
      featureId,
      vertexRef: `vertex:${featureId}:${lineId}:end`,
      entityRef: `entity:${featureId}:${lineId}`,
    }
    if (!sameVertex) {
      if (endRef) {
        mutations.push(...insertCoincidentPoint(endRef, endTarget))
      }
      if (inserter.foundHorizontal()) {
        mutations.push(...insertAxisConstraint('horizontal', endTarget))
      }
      if (inserter.foundVertical()) {
        mutations.push(...insertAxisConstraint('vertical', endTarget))
      }
    }

    if (closesChain) {
      return { mutations, nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
    }

    // Chain: the just-drawn endpoint becomes the next start. Seed the next
    // segment from the vertex that endpoint IS -- the old point the next click
    // will snap to -- so consecutive segments are joined by a real coincident
    // instead of merely agreeing on coordinates. An end that landed on someone
    // else's vertex hands that vertex over instead, so the chain continues from
    // the point the user actually snapped to.
    return {
      mutations,
      nextDrawPoints: [...pts.map(p => [p[0], p[1]] as [number, number]), [px, py]],
      // An end that landed on a curve does NOT hand that curve to the next
      // segment: the next segment starts at this line's own end vertex, which
      // the point-on-path constraint already keeps on the curve.
      nextDrawSnap: { refs: [
        ...snap.drawSnapRefs.slice(0, pts.length),
        inserter.foundSnappablePoint() ? endRef : `vertex:${featureId}:${lineId}:end`,
      ] },
      gestureComplete: false,
    }
  }

  if (t === 'circle') {
    if (pts.length === 0) {
      const drawSnap = startSnap()
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }

    const r = Math.hypot(px - pts[0][0], py - pts[0][1])
    if (r <= 0) return nothing
    const circleId = newEntityIdFn()
    const params = [pts[0][0], pts[0][1], r]
    const centreRef = snap.drawSnapRefs[0] ?? null
    const mutations: Mutation[] = [
      centreRef
        ? { type: 'add_entity_with_constraint', featureId, kind: 'circle', params,
            vertexKey: 'center', ...carriedSnapFields(centreRef), constraintKind: 'coincident',
            entityId: circleId }
        : { type: 'add_entity', featureId, kind: 'circle', params, entityId: circleId },
    ]
    mutations.push(...onCurveThroughSnappedVertex(circleId, centreRef))
    return { mutations, nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
  }

  if (t === 'ellipse') {
    if (pts.length === 0) {
      const drawSnap = startSnap()
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }

    // Second click sets the major axis: `a` is the cursor distance, the major
    // axis points at the cursor (theta), and `b` falls back to the golden ratio.
    const dx = px - pts[0][0]
    const dy = py - pts[0][1]
    const a = Math.hypot(dx, dy)
    if (a <= 0) return nothing
    const theta = Math.atan2(dy, dx) * (180 / Math.PI)
    const b = a * ELLIPSE_MINOR_RATIO
    const params = [pts[0][0], pts[0][1], a, b, theta]
    const ellipseId = newEntityIdFn()
    const centreRef = snap.drawSnapRefs[0] ?? null
    const mutations: Mutation[] = [
      centreRef
        ? { type: 'add_entity_with_constraint', featureId, kind: 'ellipse', params,
            vertexKey: 'center', ...carriedSnapFields(centreRef), constraintKind: 'coincident',
            entityId: ellipseId }
        : { type: 'add_entity', featureId, kind: 'ellipse', params, entityId: ellipseId },
    ]
    mutations.push(...onCurveThroughSnappedVertex(ellipseId, centreRef))
    return { mutations, nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
  }

  if (t === 'spline') {
    // 4-click cubic Bezier: P1 (start), P2/P3 (control handles), P4 (end).
    if (pts.length === 0) {
      const drawSnap = startSnap()
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }
    if (pts.length < 3) {
      const next: [number, number][] = [...pts.map(p => [p[0], p[1]] as [number, number]), [px, py]]
      // Refs stay one per placed point. A control handle's ref authors nothing
      // (handles are off the curve); only [0] is read back, on the last click.
      const refs = [...pts.map((_, i) => snap.drawSnapRefs[i] ?? null), clickedRef()]
      return { mutations: [], nextDrawPoints: next, nextDrawSnap: { refs }, gestureComplete: false }
    }
    // Fourth click closes the curve.
    const params = [pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1], px, py]
    const splineId = newEntityIdFn()
    const startRef = snap.drawSnapRefs[0] ?? null
    const endRef = clickedRef()
    const mutations: Mutation[] = [
      startRef
        ? { type: 'add_entity_with_constraint', featureId, kind: 'spline',
            params, vertexKey: 'start',
            ...carriedSnapFields(startRef), constraintKind: 'coincident', entityId: splineId }
        : { type: 'add_entity', featureId, kind: 'spline', params, entityId: splineId },
    ]
    // The spline carries no axis constraint (its shape is the control polygon's,
    // not a direction), so only the two point questions are asked. An end on the
    // vertex the start is already pinned to would restate that coincident; an
    // end elsewhere on the start's curve is a second point on it and is pinned.
    if (endRef && !sameSnapVertex(endRef, startRef)) {
      mutations.push(...insertCoincidentPoint(endRef, {
        featureId, vertexRef: `vertex:${featureId}:${splineId}:end`,
      }))
    }
    return { mutations, nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
  }

  if (t === 'arc') {
    if (pts.length === 0) {
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: startSnap(), gestureComplete: false }
    }
    if (pts.length === 1) {
      // A second click that lands back on the first point (a double click, or
      // both clicks snapped to one vertex) would leave two coincident points.
      // The third click then has no circumcircle, so every later click fails
      // and the tool dead-ends. Re-arm from that single point instead of
      // appending a duplicate, so the gesture can recover.
      if (Math.abs(px - pts[0][0]) < SNAP_EPS && Math.abs(py - pts[0][1]) < SNAP_EPS) {
        return {
          mutations: [], nextDrawPoints: [[pts[0][0], pts[0][1]]],
          nextDrawSnap: { refs: [snap.drawSnapRefs[0] ?? null] },
          gestureComplete: false,
        }
      }
      // Append second point; preserve first (use explicit tuple copy to satisfy types)
      return {
        mutations: [], nextDrawPoints: [[pts[0][0], pts[0][1]], [px, py]],
        nextDrawSnap: { refs: [snap.drawSnapRefs[0] ?? null, clickedRef()] },
        gestureComplete: false,
      }
    }

    // Third click: compute arc from 3 points
    const cc = circumcircle(pts[0], pts[1], [px, py])
    if (!cc) return nothing

    // The arc is stored CCW from angle_start, so the bulge click decides which
    // of the two clicked ends became the `start` vertex. The snaps were made on
    // the points, not on the angles: they follow their own point across the swap.
    const { angles: [aStart, aEnd], startsAtFirst } = arcEndpointOrder(cc.cx, cc.cy, pts[0], pts[1], [px, py])
    const arcId = newEntityIdFn()
    const params = [cc.cx, cc.cy, cc.r, aStart, aEnd]
    const [firstKey, secondKey] = startsAtFirst ? ['start', 'end'] : ['end', 'start']
    const firstRef = snap.drawSnapRefs[0] ?? null
    const secondRef = snap.drawSnapRefs[1] ?? null

    // The seed constraint rides along with the entity so the pair commits
    // atomically; a second snapped end is a plain constraint on the same batch
    // (skipped only when it names the first end's vertex again).
    const mutations: Mutation[] = [
      firstRef
        ? { type: 'add_entity_with_constraint', featureId, kind: 'arc', params,
            vertexKey: firstKey, ...carriedSnapFields(firstRef),
            constraintKind: 'coincident', entityId: arcId }
        : { type: 'add_entity', featureId, kind: 'arc', params, entityId: arcId },
    ]
    if (secondRef && !sameSnapVertex(secondRef, firstRef)) {
      mutations.push(...insertCoincidentPoint(secondRef, {
        featureId, vertexRef: `vertex:${featureId}:${arcId}:${secondKey}`,
      }))
    }
    return { mutations, nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
  }

  // The second click of the two-click shape tools (rect, center rect, n-gon).
  // An alignment snap is measured against the first click, so honouring it
  // would put both clicks on one row or column and collapse the rectangle (or
  // tilt the n-gon onto an axis the user did not ask for): that click keeps the
  // raw cursor and names nothing. A vertex or curve snap moves the point onto
  // the element and hands its ref to the doc writer, like every other tool.
  const shapeEnd = (): { at: [number, number]; ref: string | null } =>
    inserter.foundHorizontal() || inserter.foundVertical()
      ? { at: [rawPoint[0], rawPoint[1]], ref: null }
      : { at: [px, py], ref: clickedRef() }
  const done = (mutation: Mutation): DrawClickResult =>
    ({ mutations: [mutation], nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true })

  // A degenerate second click (no extent on an axis, zero radius) returns
  // `nothing`: the first click stays in the buffer so the user can click again,
  // as the circle and ellipse do. The doc writers keep the same guard as a
  // backstop for other callers.
  if (t === 'rect') {
    if (pts.length === 0) {
      const drawSnap = startSnap()
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }
    const end = shapeEnd()
    if (!isProperRect(pts[0][0], pts[0][1], end.at[0], end.at[1])) return nothing
    return done({ type: 'add_rect', featureId, p0: pts[0], p1: end.at,
      p0Ref: snap.drawSnapRefs[0] ?? null, p1Ref: end.ref })
  }

  if (t === 'center_rect') {
    if (pts.length === 0) {
      const drawSnap = startSnap()
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }
    const end = shapeEnd()
    if (!isProperRect(...centerRectCorners(pts[0], end.at))) return nothing
    return done({ type: 'add_center_rect', featureId, center: pts[0], corner: end.at,
      centerRef: snap.drawSnapRefs[0] ?? null, cornerRef: end.ref })
  }

  if (t === 'ngon') {
    if (pts.length === 0) {
      // The center click's snap is pinned to the construction circle's center.
      const drawSnap = startSnap()
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }
    // Second click sets a vertex (circumradius + start angle).
    const end = shapeEnd()
    // Negated so a NaN radius (a raw cursor the finite gate above never saw)
    // is refused too.
    if (!(Math.hypot(end.at[0] - pts[0][0], end.at[1] - pts[0][1]) > 0)) return nothing
    const sides = Math.max(3, Math.floor(snap.ngonSides ?? 6))
    return done({ type: 'add_ngon', featureId, center: pts[0], corner: end.at, sides,
      centerRef: snap.drawSnapRefs[0] ?? null, cornerRef: end.ref })
  }

  if (t === 'project') {
    const hid = snap.hoveredSelectionId
    if (!hid) return nothing

    // The hovered pick already carries its own kind/face-boundary answers, so
    // the resolvers ignore the queried id and hand back the hover state.
    const mutations = projectionMutationsForId(hid, featureId, {
      entityKind: (fid, eid) => {
        const entity = otherSketches?.[fid]?.[eid] ?? sketch?.[eid]
        return entity ? getEntityKind(entity) : null
      },
      edgeKind: () => snap.hoveredSourceKind ?? null,
      faceEdges: () => snap.hoveredFaceEdges ?? null,
    })
    if (mutations.length === 0) return nothing
    return { mutations, nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
  }

  return nothing
}

/** Tools whose second click refuses an alignment snap (the `shapeEnd` rule
 *  above): the snap is measured against the first click, so it would collapse
 *  a rectangle to a line or twist the n-gon's orientation. Vertex and curve
 *  snaps still move the point. The single source for the preview here and for
 *  the alignment guide, which must not promise these tools a snap. */
export const ALIGNMENT_BLIND_TOOLS: ReadonlySet<string> = new Set(['rect', 'center_rect', 'ngon'])

/** The point the next click at `rawPoint` would commit, for the preview.
 *
 *  Reads the snap through the same insertion helper `computeDrawClick` uses,
 *  so the rubber band ends where the entity will: the preview must not draw to
 *  the raw cursor and then jump on click. Keep the per-tool exceptions here in
 *  step with the branches above. */
export function resolveDrawCursor(
  tool: string,
  drawPoints: readonly [number, number][],
  rawPoint: readonly [number, number],
  snap: DrawSnapState,
  sketch?: Record<string, Entity>,
  otherSketches?: Record<string, Record<string, Entity>>,
): [number, number] {
  const inserter = createInsertionHelper({ sketch, otherSketches })
  inserter.update(snap, rawPoint)
  if (drawPoints.length > 0 && ALIGNMENT_BLIND_TOOLS.has(tool) &&
      (inserter.foundHorizontal() || inserter.foundVertical())) {
    return [rawPoint[0], rawPoint[1]]
  }
  return inserter.getPoint()
}

