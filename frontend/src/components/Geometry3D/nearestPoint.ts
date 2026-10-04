// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { LineSegment, Circle, Arc, PointEntity, Entity } from '@/types/cad'
import { getEntityKind } from '@/types/cad'

export interface NearestPointResult {
  position: [number, number]
  distance: number
}

export function nearestPointOnLine(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number
): NearestPointResult {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return { position: [x1, y1], distance: Math.hypot(px - x1, py - y1) }

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))

  const nx = x1 + t * dx
  const ny = y1 + t * dy
  return { position: [nx, ny], distance: Math.hypot(px - nx, py - ny) }
}

export function nearestPointOnCircle(
  px: number, py: number,
  cx: number, cy: number, r: number
): NearestPointResult {
  const angle = Math.atan2(py - cy, px - cx)
  const nx = cx + r * Math.cos(angle)
  const ny = cy + r * Math.sin(angle)
  return { position: [nx, ny], distance: Math.hypot(px - nx, py - ny) }
}

export function nearestPointOnArc(
  px: number, py: number,
  cx: number, cy: number, r: number,
  angleStart: number, angleEnd: number
): NearestPointResult {
  const toAngle = (a: number) => {
    while (a < 0) a += 360
    while (a >= 360) a -= 360
    return a
  }
  const start = toAngle(angleStart)
  const end = toAngle(angleEnd)

  const pointAngle = toAngle(Math.atan2(py - cy, px - cx) * 180 / Math.PI)

  let onArc = false
  if (end > start) {
    onArc = pointAngle >= start && pointAngle <= end
  } else {
    onArc = pointAngle >= start || pointAngle <= end
  }

  if (onArc) {
    return nearestPointOnCircle(px, py, cx, cy, r)
  }

  const startPoint: NearestPointResult = {
    position: [cx + r * Math.cos(angleStart * Math.PI / 180), cy + r * Math.sin(angleStart * Math.PI / 180)],
    distance: Math.hypot(px - (cx + r * Math.cos(angleStart * Math.PI / 180)), py - (cy + r * Math.sin(angleStart * Math.PI / 180)))
  }
  const endPoint: NearestPointResult = {
    position: [cx + r * Math.cos(angleEnd * Math.PI / 180), cy + r * Math.sin(angleEnd * Math.PI / 180)],
    distance: Math.hypot(px - (cx + r * Math.cos(angleEnd * Math.PI / 180)), py - (cy + r * Math.sin(angleEnd * Math.PI / 180)))
  }

  return startPoint.distance < endPoint.distance ? startPoint : endPoint
}

export function nearestPointOnEntity(
  px: number, py: number,
  entity: Entity
): NearestPointResult | null {
  const kind = getEntityKind(entity)
  if (kind === 'arc') {
    const arc = entity as Arc
    return nearestPointOnArc(px, py, arc.center[0], arc.center[1], arc.radius, arc.angle_start, arc.angle_end)
  } else if (kind === 'line') {
    const line = entity as LineSegment
    return nearestPointOnLine(px, py, line.start[0], line.start[1], line.end[0], line.end[1])
  } else if (kind === 'circle') {
    const circ = entity as Circle
    return nearestPointOnCircle(px, py, circ.center[0], circ.center[1], circ.radius)
  } else if ('x' in entity) {
    const pt = entity as PointEntity
    return { position: [pt.x, pt.y], distance: Math.hypot(px - pt.x, py - pt.y) }
  }
  return null
}
