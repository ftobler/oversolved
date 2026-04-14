// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Mutation, Entity } from '../../types/cad'
import type { SnapKind } from '../../registry'
import { suggestConstraint } from '../../registry'

export interface DrawSnapState {
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: SnapKind | null
  /** Composite ID: "entity:featureId:entityId" or null */
  hoveredEntityId: string | null
  pathSnapPosition: [number, number] | null
  pathSnapEntityRef: string | null
  drawSnapVertexId: string | null
  drawSnapEntityRef: string | null
  alignmentSnapPoint: [number, number] | null
  alignmentSnapKind: string | null
  alignmentSnapVertexId: string | null
}

export interface DrawClickResult {
  mutations: Mutation[]
  /**
   * null  -- leave draw points unchanged (adapter calls clearDraw on clearTool=true)
   * array -- replace draw points with this array (intermediate clicks, arc 2nd click)
   */
  nextDrawPoints: [number, number][] | null
  /** null means leave draw snap unchanged; an object replaces both fields. */
  nextDrawSnap: { vertexId: string | null; entityRef: string | null } | null
  /** When true the adapter must call clearDraw() + setActiveTool(null). */
  clearTool: boolean
}

/** Resolve the effective click position from snap state.
 *  Priority: alignment snap (projected onto axis) > vertex hover > path snap > raw cursor. */
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
  if (snap.pathSnapPosition) return snap.pathSnapPosition
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

  if (tool === 'point') {
    return {
      mutations: [{ type: 'add_entity', featureId, kind: 'point', params: [px, py] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      clearTool: true,
    }
  }

  if (tool === 'line') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId, entityRef: null }
        : snap.pathSnapPosition && snap.pathSnapEntityRef
          ? { vertexId: null, entityRef: snap.pathSnapEntityRef }
          : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }

    const lineId = newEntityIdFn()
    const mutations: Mutation[] = []
    const startSnapVertexId = snap.drawSnapVertexId
    const startSnapEntityRef = snap.drawSnapEntityRef
    const hasStartSnap = !!(startSnapVertexId || startSnapEntityRef)
    const hasEndSnap = !!(
      (snap.alignmentSnapPoint && snap.alignmentSnapKind && snap.alignmentSnapVertexId) ||
      (snap.hoveredVertexId && snap.hoveredSnapKind) ||
      (snap.pathSnapPosition && snap.pathSnapEntityRef)
    )

    if (hasStartSnap || hasEndSnap) {
      if (startSnapVertexId) {
        mutations.push({ type: 'add_entity_with_constraint', featureId, kind: 'line',
          params: [pts[0][0], pts[0][1], px, py], vertexKey: 'start',
          snapVertexId: startSnapVertexId, constraintKind: 'coincident', entityId: lineId })
      } else if (startSnapEntityRef) {
        mutations.push({ type: 'add_entity_with_constraint', featureId, kind: 'line',
          params: [pts[0][0], pts[0][1], px, py], vertexKey: 'start',
          constraintKind: 'coincident', snapEntityRef: startSnapEntityRef, entityId: lineId })
      } else {
        mutations.push({ type: 'add_entity', featureId, kind: 'line',
          params: [pts[0][0], pts[0][1], px, py], entityId: lineId })
      }

      if (snap.alignmentSnapPoint && snap.alignmentSnapKind && snap.alignmentSnapVertexId) {
        const constraintKind = snap.alignmentSnapKind === 'kinda_horizontal' ? 'horizontal' : 'vertical'
        if (snap.alignmentSnapVertexId === 'draw:last') {
          mutations.push({ type: 'add_constraint', featureId, kind: constraintKind,
            targets: [`entity:${featureId}:${lineId}`] })
        } else {
          mutations.push({ type: 'add_constraint', featureId, kind: constraintKind,
            targets: [`vertex:${featureId}:${lineId}:end`, snap.alignmentSnapVertexId] })
        }
      } else if (snap.hoveredVertexId && snap.hoveredSnapKind) {
        const constraintKind = suggestConstraint('vertex', snap.hoveredSnapKind) ?? 'coincident'
        mutations.push({ type: 'add_constraint', featureId, kind: constraintKind,
          targets: [`vertex:${featureId}:${lineId}:end`, snap.hoveredVertexId] })
      } else if (snap.pathSnapPosition && snap.pathSnapEntityRef) {
        mutations.push({ type: 'add_constraint', featureId, kind: 'coincident',
          targets: [`vertex:${featureId}:${lineId}:end`, `entity:${featureId}:*`] })
      }
    } else {
      mutations.push({ type: 'add_entity', featureId, kind: 'line',
        params: [pts[0][0], pts[0][1], px, py] })
    }

    return { mutations, nextDrawPoints: null, nextDrawSnap: null, clearTool: true }
  }

  if (tool === 'circle') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId, entityRef: null }
        : snap.pathSnapPosition && snap.pathSnapEntityRef
          ? { vertexId: null, entityRef: snap.pathSnapEntityRef }
          : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }

    const r = Math.hypot(px - pts[0][0], py - pts[0][1])
    if (r <= 0) return nothing
    const centerSnapVertexId = snap.drawSnapVertexId
    const centerSnapEntityRef = snap.drawSnapEntityRef
    let mutation: Mutation
    if (centerSnapVertexId) {
      mutation = { type: 'add_entity_with_constraint', featureId, kind: 'circle',
        params: [pts[0][0], pts[0][1], r], vertexKey: 'center',
        snapVertexId: centerSnapVertexId, constraintKind: 'coincident' }
    } else if (centerSnapEntityRef) {
      mutation = { type: 'add_entity_with_constraint', featureId, kind: 'circle',
        params: [pts[0][0], pts[0][1], r], vertexKey: 'center',
        constraintKind: 'coincident', snapEntityRef: centerSnapEntityRef }
    } else {
      mutation = { type: 'add_entity', featureId, kind: 'circle',
        params: [pts[0][0], pts[0][1], r] }
    }
    return { mutations: [mutation], nextDrawPoints: null, nextDrawSnap: null, clearTool: true }
  }

  if (tool === 'arc') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId, entityRef: null }
        : snap.pathSnapPosition && snap.pathSnapEntityRef
          ? { vertexId: null, entityRef: snap.pathSnapEntityRef }
          : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }
    if (pts.length === 1) {
      // Append second point; preserve first (use explicit tuple copy to satisfy types)
      return { mutations: [], nextDrawPoints: [[pts[0][0], pts[0][1]], [px, py]], nextDrawSnap: null, clearTool: false }
    }

    // Third click: compute arc from 3 points
    const cc = circumcircle3(pts[0], pts[1], [px, py])
    if (!cc || cc.r <= 0) return nothing
    const [aStart, aEnd] = arcAngles3(cc.cx, cc.cy, pts[0], pts[1], [px, py])
    return {
      mutations: [{ type: 'add_entity', featureId, kind: 'arc',
        params: [cc.cx, cc.cy, cc.r, aStart, aEnd] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      clearTool: true,
    }
  }

  if (tool === 'rect') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId, entityRef: null }
        : snap.pathSnapPosition && snap.pathSnapEntityRef
          ? { vertexId: null, entityRef: snap.pathSnapEntityRef }
          : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }
    return {
      mutations: [{ type: 'add_rect', featureId, p0: pts[0], p1: [px, py] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      clearTool: true,
    }
  }

  if (tool === 'center_rect') {
    if (pts.length === 0) {
      const drawSnap = snap.hoveredVertexId
        ? { vertexId: snap.hoveredVertexId, entityRef: null }
        : snap.pathSnapPosition && snap.pathSnapEntityRef
          ? { vertexId: null, entityRef: snap.pathSnapEntityRef }
          : null
      return { mutations: [], nextDrawPoints: [[px, py]], nextDrawSnap: drawSnap, clearTool: false }
    }
    return {
      mutations: [{ type: 'add_center_rect', featureId, center: pts[0], corner: [px, py] }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      clearTool: true,
    }
  }

  if (tool === 'project') {
    const hid = snap.hoveredEntityId
    if (!hid || !hid.startsWith('entity:')) return nothing
    const parts = hid.split(':')
    if (parts.length < 3) return nothing
    const sourceFeatureId = parts[1]
    const sourceEntityId = parts[2]
    if (sourceFeatureId === featureId) return nothing

    const source = `@${sourceFeatureId}/${sourceEntityId}`
    let kind = 'projected_line'
    const entity = otherSketches?.[sourceFeatureId]?.[sourceEntityId]
      ?? sketch?.[sourceEntityId]
    if (entity) {
      if ('radius' in entity && 'angle_start' in entity) kind = 'projected_arc'
      else if ('radius' in entity) kind = 'projected_circle'
      else if ('x' in entity) kind = 'projected_point'
    }
    return {
      mutations: [{ type: 'add_projected_entity', featureId, kind, source }],
      nextDrawPoints: null,
      nextDrawSnap: null,
      clearTool: true,
    }
  }

  return nothing
}

/** Compute circumcircle of 3 points. Returns null if points are collinear. */
function circumcircle3(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
): { cx: number; cy: number; r: number } | null {
  const ax = p1[0], ay = p1[1]
  const bx = p2[0], by = p2[1]
  const cx = p3[0], cy = p3[1]
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(D) < 1e-10) return null
  const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D
  const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D
  return { cx: ux, cy: uy, r: Math.hypot(ax - ux, ay - uy) }
}

/** Determine [aStart, aEnd] such that going CCW from aStart reaches aEnd,
 *  with the arc passing through the radius point p3. */
function arcAngles3(
  cx: number, cy: number,
  start: readonly [number, number],
  end: readonly [number, number],
  radiusPt: readonly [number, number],
): [number, number] {
  const toDeg = (a: number) => a * (180 / Math.PI)
  const norm = (a: number) => ((a % 360) + 360) % 360
  const aStart = toDeg(Math.atan2(start[1] - cy, start[0] - cx))
  const aEnd = toDeg(Math.atan2(end[1] - cy, end[0] - cx))
  const aRadius = toDeg(Math.atan2(radiusPt[1] - cy, radiusPt[0] - cx))
  const s = norm(aStart), e = norm(aEnd), rp = norm(aRadius)
  const spanCCW = ((e - s) + 360) % 360
  const rpInCCW = ((rp - s) + 360) % 360 < spanCCW
  return rpInCCW ? [aStart, aEnd] : [aEnd, aStart]
}
