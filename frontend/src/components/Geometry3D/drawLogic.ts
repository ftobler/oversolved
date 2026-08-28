// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Mutation, Entity } from '@/types/cad'
import type { SnapKind } from '@/registry'
import { suggestConstraint } from '@/registry'
import { getEntityKind } from '@/types/cad'
import { projectionMutationsForId } from '@/tools/projectionMutations'
import { circumcircle, arcAnglesFromRadiusPoint, ELLIPSE_MINOR_RATIO } from '@/components/Geometry3D/drawGeometry'
import { isFiniteSketchPoint } from '@/components/Geometry3D/pointerAbstraction'
import { failLoud } from '@/stores/stateInvariants'

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
  drawSnapVertexId: string | null
  alignmentSnapPoint: [number, number] | null
  // An alignment snap is measured against the last draw point, i.e. the segment's
  // own start. It names no second vertex, which is why there is no id here.
  alignmentSnapKind: 'kinda_horizontal' | 'kinda_vertical' | null
  // Side count for the two-click n-gon tool. Defaults to 6 when absent.
  ngonSides?: number
}

export interface DrawClickResult {
  mutations: Mutation[]
  /**
   * null  -- leave draw points unchanged
   * array -- replace draw points with this array (intermediate clicks, arc 2nd click)
   */
  nextDrawPoints: [number, number][] | null
  // null means leave draw snap unchanged; a string replaces the vertexId.
  nextDrawSnap: { vertexId: string | null } | null
  // true when this click completed the gesture and produced its entity; the
  // adapter clears the draw buffer and consults the tool's
  // `staysArmedAfterCommit` policy to decide whether to keep the tool armed.
  gestureComplete: boolean
}

// Click positions that agree within this distance are the same vertex, used by
// the line tool to detect a closing click on the open polyline endpoint.
const SNAP_EPS = 1e-6

/** What the snap under a segment's end click asks the document to record.
 *
 *  The two snaps that can resolve one click are not the same kind of statement
 *  and must not collapse into one. Landing on an existing vertex says "these two
 *  points are the same point": a coincident between a point pair. An alignment
 *  snap says "this segment runs along an axis"; it is measured against the last
 *  draw point, which is the segment's OWN start, so it constrains the line and
 *  names no second vertex at all. Treating the alignment case as a vertex snap
 *  is what used to author `coincident` against the alignment reference. */
type EndSnap =
  | { kind: 'coincident'; vertexId: string }
  | { kind: 'horizontal' | 'vertical' }

/** Resolve the end snap from the same signals resolveSnapPoint consumed, rather
 *  than from a separate, sometimes-stale, hover gate. Alignment wins (it is what
 *  moved the point), then a vertex-hover whose resolved point equals the click,
 *  then the legacy hoveredVertexId/hoveredSnapKind pair. */
function resolveEndSnap(snap: DrawSnapState, px: number, py: number): EndSnap | null {
  if (snap.alignmentSnapPoint && snap.alignmentSnapKind) {
    const kind = suggestConstraint('vertex', snap.alignmentSnapKind)
    // The registry owns the snap -> constraint mapping; anything but the two
    // axis constraints means an alignment kind grew a meaning this branch does
    // not implement, and authoring a guess would poison the sketch.
    if (kind === 'horizontal' || kind === 'vertical') return { kind }
    return null
  }
  if (snap.hoveredVertexPosition &&
      Math.abs(px - snap.hoveredVertexPosition[0]) < SNAP_EPS &&
      Math.abs(py - snap.hoveredVertexPosition[1]) < SNAP_EPS) {
    return snap.hoveredVertexId ? { kind: 'coincident', vertexId: snap.hoveredVertexId } : null
  }
  if (snap.hoveredVertexId && snap.hoveredSnapKind) {
    return { kind: 'coincident', vertexId: snap.hoveredVertexId }
  }
  return null
}

/** Resolve the effective click position from snap state.
 *  Priority: alignment snap (projected onto axis) > vertex hover > raw cursor. */
export function resolveSnapPoint(
  rawPoint: readonly [number, number],
  snap: DrawSnapState,
): [number, number] {
  if (snap.alignmentSnapPoint && snap.alignmentSnapKind) {
    if (snap.alignmentSnapKind === 'kinda_horizontal') {
      return [rawPoint[0], snap.alignmentSnapPoint[1]]
    }
    return [snap.alignmentSnapPoint[0], rawPoint[1]]
  }
  if (snap.hoveredVertexPosition) return snap.hoveredVertexPosition
  return [rawPoint[0], rawPoint[1]]
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
  const [px, py] = resolveSnapPoint(rawPoint, snap)
  const pts = drawPoints

  const nothing: DrawClickResult = { mutations: [], nextDrawPoints: null, nextDrawSnap: null, gestureComplete: false }

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
    return {
      mutations: [{ type: 'add_entity', featureId, kind: 'point', params: [px, py] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      gestureComplete: true,
    }
  }

  if (t === 'line') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
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

    const lineId = newEntityIdFn()
    const mutations: Mutation[] = []
    const startVertexId = snap.drawSnapVertexId
    const endSnap = resolveEndSnap(snap, px, py)
    const endVertexId = endSnap?.kind === 'coincident' ? endSnap.vertexId : null
    // Both ends on the SAME vertex make a zero-length line: drop the constraints
    // and fall back to a free line so the kernel does not silently discard it.
    const sameVertex = !!startVertexId && startVertexId === endVertexId

    const segStart = pts[pts.length - 1]
    // Take the closing endpoint from the chain's own first point rather than the
    // resolved click, so a loop closes on the exact coordinate it opened at.
    const segEnd = closesChain ? startPoint : [px, py]
    const params = [segStart[0], segStart[1], segEnd[0], segEnd[1]]

    if (startVertexId && !sameVertex) {
      mutations.push({ type: 'add_entity_with_constraint', featureId, kind: 'line',
        params, vertexKey: 'start',
        snapVertexId: startVertexId, constraintKind: 'coincident', entityId: lineId })
    } else {
      mutations.push({ type: 'add_entity', featureId, kind: 'line', params, entityId: lineId })
    }

    if (endSnap && !sameVertex) {
      if (endSnap.kind === 'coincident') {
        mutations.push({ type: 'add_constraint', featureId, kind: 'coincident',
          targets: [`vertex:${featureId}:${lineId}:end`, endSnap.vertexId] })
      } else {
        // An axis alignment describes the whole segment, so it takes the
        // single-target form of horizontal/vertical, not a point pair.
        mutations.push({ type: 'add_constraint', featureId, kind: endSnap.kind,
          targets: [`entity:${featureId}:${lineId}`] })
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
      nextDrawSnap: { vertexId: endVertexId ?? `vertex:${featureId}:${lineId}:end` },
      gestureComplete: false,
    }
  }

  if (t === 'circle') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }

    const r = Math.hypot(px - pts[0][0], py - pts[0][1])
    if (r <= 0) return nothing
    let mutation: Mutation
    if (snap.drawSnapVertexId) {
      mutation = { type: 'add_entity_with_constraint', featureId, kind: 'circle',
        params: [pts[0][0], pts[0][1], r], vertexKey: 'center',
        snapVertexId: snap.drawSnapVertexId, constraintKind: 'coincident' }
    } else {
      mutation = { type: 'add_entity', featureId, kind: 'circle',
        params: [pts[0][0], pts[0][1], r] }
    }
    return { mutations: [mutation], nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
  }

  if (t === 'ellipse') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
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
    let mutation: Mutation
    if (snap.drawSnapVertexId) {
      mutation = { type: 'add_entity_with_constraint', featureId, kind: 'ellipse',
        params, vertexKey: 'center',
        snapVertexId: snap.drawSnapVertexId, constraintKind: 'coincident' }
    } else {
      mutation = { type: 'add_entity', featureId, kind: 'ellipse', params }
    }
    return { mutations: [mutation], nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
  }

  if (t === 'spline') {
    // 4-click cubic Bezier: P1 (start), P2/P3 (control handles), P4 (end).
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId ? { vertexId: snap.hoveredVertexId } : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }
    if (pts.length < 3) {
      const next: [number, number][] = [...pts.map(p => [p[0], p[1]] as [number, number]), [px, py]]
      return { mutations: [], nextDrawPoints: next, nextDrawSnap: null, gestureComplete: false }
    }
    // Fourth click closes the curve.
    const params = [pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1], px, py]
    let mutation: Mutation
    if (snap.drawSnapVertexId) {
      mutation = { type: 'add_entity_with_constraint', featureId, kind: 'spline',
        params, vertexKey: 'start',
        snapVertexId: snap.drawSnapVertexId, constraintKind: 'coincident' }
    } else {
      mutation = { type: 'add_entity', featureId, kind: 'spline', params }
    }
    return { mutations: [mutation], nextDrawPoints: null, nextDrawSnap: null, gestureComplete: true }
  }

  if (t === 'arc') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }
    if (pts.length === 1) {
      // Append second point; preserve first (use explicit tuple copy to satisfy types)
      return { mutations: [], nextDrawPoints: [[pts[0][0], pts[0][1]], [px, py]], nextDrawSnap: null, gestureComplete: false }
    }

    // Third click: compute arc from 3 points
    const cc = circumcircle(pts[0], pts[1], [px, py])
    if (cc) {
      const [aStart, aEnd] = arcAnglesFromRadiusPoint(cc.cx, cc.cy, pts[0], pts[1], [px, py])
    return {
      mutations: [{ type: 'add_entity', featureId, kind: 'arc',
        params: [cc.cx, cc.cy, cc.r, aStart, aEnd] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      gestureComplete: true,
    }
  }

  }
  if (t === 'rect') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }
    // Second corner uses raw point, alignment snap would collapse the rectangle
    return {
      mutations: [{ type: 'add_rect', featureId, p0: pts[0], p1: [rawPoint[0], rawPoint[1]] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      gestureComplete: true,
    }
  }

  if (t === 'center_rect') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }
    // Second corner uses raw point, alignment snap would collapse the rectangle
    return {
      mutations: [{ type: 'add_center_rect', featureId, center: pts[0], corner: [rawPoint[0], rawPoint[1]] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      gestureComplete: true,
    }
  }

  if (t === 'ngon') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, gestureComplete: false }
    }
    // Second click sets a vertex (circumradius + start angle). Raw point: an
    // alignment snap would distort the polygon's orientation.
    const sides = Math.max(3, Math.floor(snap.ngonSides ?? 6))
    return {
      mutations: [{ type: 'add_ngon', featureId, center: pts[0], corner: [rawPoint[0], rawPoint[1]], sides }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      gestureComplete: true,
    }
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

