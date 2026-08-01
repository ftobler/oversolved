// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Mutation, Entity } from '@/types/cad'
import type { SnapKind } from '@/registry'
import { suggestConstraint } from '@/registry'
import { getEntityKind } from '@/types/cad'
import { projectionMutationsForId } from '@/tools/projectionMutations'
import { circumcircle, arcAnglesFromRadiusPoint, ELLIPSE_MINOR_RATIO } from '@/components/Geometry3D/drawGeometry'

export interface DrawSnapState {
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: SnapKind | null
  /** Composite ID: "entity:featureId:entityId" or null */
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
  alignmentSnapKind: string | null
  alignmentSnapVertexId: string | null
  /** Side count for the two-click n-gon tool. Defaults to 6 when absent. */
  ngonSides?: number
}

export interface DrawClickResult {
  mutations: Mutation[]
  /**
   * null  -- leave draw points unchanged (adapter calls clearDraw on clearTool=true)
   * array -- replace draw points with this array (intermediate clicks, arc 2nd click)
   */
  nextDrawPoints: [number, number][] | null
  /** null means leave draw snap unchanged; a string replaces the vertexId. */
  nextDrawSnap: { vertexId: string | null } | null
  /** When true the adapter must call clearDraw() + setActiveTool(null). */
  clearTool: boolean
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
  /** sketch and otherSketches are needed only for the 'project' tool. */
  sketch?: Record<string, Entity>,
  otherSketches?: Record<string, Record<string, Entity>>,
): DrawClickResult {
  const [px, py] = resolveSnapPoint(rawPoint, snap)
  const pts = drawPoints

  const nothing: DrawClickResult = { mutations: [], nextDrawPoints: null, nextDrawSnap: null, clearTool: false }

  const t: string = tool  // prevent type narrowing across branches
  if (t === 'point') {
    return {
      mutations: [{ type: 'add_entity', featureId, kind: 'point', params: [px, py] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      clearTool: true,
    }
  }

  if (t === 'line') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }

    const lineId = newEntityIdFn()
    const mutations: Mutation[] = []
    const hasStartSnap = !!snap.drawSnapVertexId
    const hasEndSnap = !!(
      (snap.alignmentSnapPoint && snap.alignmentSnapKind && snap.alignmentSnapVertexId) ||
      (snap.hoveredVertexId && snap.hoveredSnapKind)
    )

    if (hasStartSnap || hasEndSnap) {
      if (snap.drawSnapVertexId) {
        mutations.push({ type: 'add_entity_with_constraint', featureId, kind: 'line',
          params: [pts[0][0], pts[0][1], px, py], vertexKey: 'start',
          snapVertexId: snap.drawSnapVertexId, constraintKind: 'coincident', entityId: lineId })
      } else {
        mutations.push({ type: 'add_entity', featureId, kind: 'line',
          params: [pts[0][0], pts[0][1], px, py], entityId: lineId })
      }

      if (snap.hoveredVertexId && snap.hoveredSnapKind) {
        const constraintKind = suggestConstraint('vertex', snap.hoveredSnapKind) ?? 'coincident'
        mutations.push({ type: 'add_constraint', featureId, kind: constraintKind,
          targets: [`vertex:${featureId}:${lineId}:end`, snap.hoveredVertexId] })
      }
    } else {
      mutations.push({ type: 'add_entity', featureId, kind: 'line',
        params: [pts[0][0], pts[0][1], px, py] })
    }

    return { mutations, nextDrawPoints: null, nextDrawSnap: null, clearTool: true }
  }

  if (t === 'circle') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
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
    return { mutations: [mutation], nextDrawPoints: null, nextDrawSnap: null, clearTool: true }
  }

  if (t === 'ellipse') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
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
    return { mutations: [mutation], nextDrawPoints: null, nextDrawSnap: null, clearTool: true }
  }

  if (t === 'spline') {
    // 4-click cubic Bezier: P1 (start), P2/P3 (control handles), P4 (end).
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId ? { vertexId: snap.hoveredVertexId } : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }
    if (pts.length < 3) {
      const next: [number, number][] = [...pts.map(p => [p[0], p[1]] as [number, number]), [px, py]]
      return { mutations: [], nextDrawPoints: next, nextDrawSnap: null, clearTool: false }
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
    return { mutations: [mutation], nextDrawPoints: null, nextDrawSnap: null, clearTool: true }
  }

  if (t === 'arc') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }
    if (pts.length === 1) {
      // Append second point; preserve first (use explicit tuple copy to satisfy types)
      return { mutations: [], nextDrawPoints: [[pts[0][0], pts[0][1]], [px, py]], nextDrawSnap: null, clearTool: false }
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
      clearTool: true,
    }
  }

  }
  if (t === 'rect') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }
    // Second corner uses raw point, alignment snap would collapse the rectangle
    return {
      mutations: [{ type: 'add_rect', featureId, p0: pts[0], p1: [rawPoint[0], rawPoint[1]] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      clearTool: true,
    }
  }

  if (t === 'center_rect') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }
    // Second corner uses raw point, alignment snap would collapse the rectangle
    return {
      mutations: [{ type: 'add_center_rect', featureId, center: pts[0], corner: [rawPoint[0], rawPoint[1]] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      clearTool: true,
    }
  }

  if (t === 'ngon') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId }
        : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }
    // Second click sets a vertex (circumradius + start angle). Raw point: an
    // alignment snap would distort the polygon's orientation.
    const sides = Math.max(3, Math.floor(snap.ngonSides ?? 6))
    return {
      mutations: [{ type: 'add_ngon', featureId, center: pts[0], corner: [rawPoint[0], rawPoint[1]], sides }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      clearTool: true,
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
    return { mutations, nextDrawPoints: null, nextDrawSnap: null, clearTool: true }
  }

  return nothing
}

