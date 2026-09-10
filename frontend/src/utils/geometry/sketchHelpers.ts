import * as THREE from 'three'
import type { Entity, LineSegment, Circle, Arc, PointEntity, Ellipse, Spline, Point, Constraints } from '@/types/cad'
import { getEntityKind } from '@/types/cad'
import { RENDER_KIND_TO_ICON } from '@/registry'
import { iconModules } from '@/utils/core/iconModules'

/** Check if all values in a tuple are finite numbers. */
export function allFinite(...vals: number[]): boolean {
  return vals.every(v => Number.isFinite(v))
}

/** Group constraints by the entity their render block targets ('default' if none). */
export function groupConstraintsByEntity(constraints: Constraints): Record<string, [string, Constraints[string]][]> {
  const byEntity: Record<string, [string, Constraints[string]][]> = {}
  for (const [id, c] of Object.entries(constraints)) {
    const eid = (c.render as { entity?: string }).entity || 'default'
    if (!byEntity[eid]) byEntity[eid] = []
    byEntity[eid].push([id, c])
  }
  return byEntity
}

/** Convert a 2D Point to a 3D tuple, or return null if any value is NaN/non-finite. */
export function pointTo3D(p: Point): [number, number, number] | null {
  if (!allFinite(p[0], p[1])) return null
  return [p[0], p[1], 0]
}

export const COLOR_CONSTRAINT = '#ffd54f'

export const ICON_SIZE = 22
export const ICON_COLS = 3

export function getIconUrl(kind: string): string | undefined {
  const name = RENDER_KIND_TO_ICON[kind]
  if (!name) return undefined
  return iconModules[`/src/assets/icons/${name}.svg`]
    ?? iconModules[`../assets/icons/${name}.svg`]
}

// World units per pixel for an orthographic camera.
//
// A perspective camera has no distance-free world-per-pixel: world size depends
// on depth. The old helper's `'zoom' in camera ? 1 / zoom : 1` never caught one
// (three's PerspectiveCamera carries a `zoom` too, defaulting to 1), so every
// screen-space size silently became 1 world unit per pixel. Throw instead, so a
// future perspective mode must add its own distance-aware helper rather than
// ship wrong sizes. Inert today: every Canvas here is orthographic, and its
// call site casts to OrthographicCamera.
export function p2w(camera: THREE.Camera): number {
  const ortho = camera as THREE.OrthographicCamera
  if (!ortho.isOrthographicCamera) {
    throw new Error('p2w requires an orthographic camera; a perspective camera has no distance-free world-per-pixel')
  }
  if (!Number.isFinite(ortho.zoom) || ortho.zoom === 0) {
    throw new Error('p2w requires a finite, non-zero camera zoom')
  }
  return 1 / ortho.zoom
}

// Pre-built unit arrow shape: tip at origin, pointing +X, base at x=-1
export const ARROW_SHAPE = (() => {
  const s = new THREE.Shape()
  s.moveTo(0, 0)
  s.lineTo(-1, 0.4)
  s.lineTo(-1, -0.4)
  s.closePath()
  return s
})()

export function sampleArc(cx: number, cy: number, r: number, a0deg: number, a1deg: number): [number, number, number][] {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || !Number.isFinite(a0deg) || !Number.isFinite(a1deg)) {
    return []
  }
  let span = ((a1deg - a0deg) + 360) % 360
  const isFullCircle = span === 0
  if (isFullCircle) span = 360
  else if (span > 180) span = span - 360
  const steps = Math.max(2, Math.ceil((Math.abs(span) / 360) * 64))
  const pts: [number, number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = (a0deg + (span * i) / steps) * (Math.PI / 180)
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0])
  }
  return pts
}

/** Like sampleArc but always goes CCW from a0 to a1 without clamping to ≤ 180°.
 *  Used for arc preview where the full arc through the cursor must be drawn. */
export function sampleArcCCW(cx: number, cy: number, r: number, a0deg: number, a1deg: number): [number, number, number][] {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || !Number.isFinite(a0deg) || !Number.isFinite(a1deg)) {
    return []
  }
  let span = ((a1deg - a0deg) + 360) % 360
  if (span === 0) span = 360
  const steps = Math.max(2, Math.ceil((span / 360) * 64))
  const pts: [number, number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const a = (a0deg + (span * i) / steps) * (Math.PI / 180)
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), 0])
  }
  return pts
}

/** Sample an ellipse circumference into a closed 3D polyline.
 *  Parametric form `(a cos t, b sin t)` rotated by `thetaDeg` and translated to
 *  the center. The last point repeats the first so the polyline closes. */
export function sampleEllipse(
  cx: number, cy: number, a: number, b: number, thetaDeg: number, steps = 64,
): [number, number, number][] {
  if (!allFinite(cx, cy, a, b, thetaDeg)) return []
  const th = thetaDeg * (Math.PI / 180)
  const ct = Math.cos(th), st = Math.sin(th)
  const pts: [number, number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    const ex = a * Math.cos(t)
    const ey = b * Math.sin(t)
    pts.push([cx + ex * ct - ey * st, cy + ex * st + ey * ct, 0])
  }
  return pts
}

/** Sample a cubic Bezier `B(t)` defined by four control points into a polyline.
 *  P1/P4 are on-curve endpoints, P2/P3 the off-curve handles. */
export function sampleBezier(
  p1: Point, p2: Point, p3: Point, p4: Point, steps = 32,
): [number, number, number][] {
  if (!allFinite(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1], p4[0], p4[1])) return []
  const pts: [number, number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    const a = mt * mt * mt
    const b = 3 * mt * mt * t
    const c = 3 * mt * t * t
    const d = t * t * t
    pts.push([
      a * p1[0] + b * p2[0] + c * p3[0] + d * p4[0],
      a * p1[1] + b * p2[1] + c * p3[1] + d * p4[1],
      0,
    ])
  }
  return pts
}

// The ellipse axis keys and their derived-point math live in `ellipseAxis.ts`,
// which imports nothing so the kernel drag path can use it inside the worker.
// Re-exported here because this module is the geometry entry point most sketch
// callers already reach for.
export { ELLIPSE_AXIS_KEYS, ellipseAxisPoints, ellipseAxisDrag, isEllipseAxisKey } from './ellipseAxis'
export type { EllipseAxisKey } from './ellipseAxis'

/** Center of a conic entity, or null for a curve that has none (line, spline,
 *  point). A projected circular edge carries its center onto the sketch plane --
 *  a tilted circle lowers to an ellipse whose center is still the projected
 *  circle center -- so the center is a handle of the curve, not a separate
 *  entity. Returns null on a non-finite center so callers never draw at NaN. */
export function entityCenter(entity: Entity): [number, number] | null {
  const kind = getEntityKind(entity)
  if (kind !== 'circle' && kind !== 'arc' && kind !== 'ellipse') return null
  const c = (entity as Circle | Arc | Ellipse).center
  return allFinite(c[0], c[1]) ? [c[0], c[1]] : null
}

export function getEntityBounds(entity: Entity): { minX: number; maxX: number; minY: number; maxY: number } {
  const kind = getEntityKind(entity)
  if (kind === 'arc') {
    const arc = entity as Arc
    const pts: [number, number][] = [arc.start, arc.end,
      [arc.center[0] - arc.radius, arc.center[1]], [arc.center[0] + arc.radius, arc.center[1]],
      [arc.center[0], arc.center[1] - arc.radius], [arc.center[0], arc.center[1] + arc.radius],
    ]
    return { minX: Math.min(...pts.map(p => p[0])), maxX: Math.max(...pts.map(p => p[0])), minY: Math.min(...pts.map(p => p[1])), maxY: Math.max(...pts.map(p => p[1])) }
  } else if (kind === 'line') {
    const l = entity as LineSegment
    return { minX: Math.min(l.start[0], l.end[0]), maxX: Math.max(l.start[0], l.end[0]), minY: Math.min(l.start[1], l.end[1]), maxY: Math.max(l.start[1], l.end[1]) }
  } else if (kind === 'circle') {
    const c = entity as Circle
    return { minX: c.center[0] - c.radius, maxX: c.center[0] + c.radius, minY: c.center[1] - c.radius, maxY: c.center[1] + c.radius }
  } else if (kind === 'ellipse') {
    const el = entity as Ellipse
    const th = el.theta * (Math.PI / 180)
    // Axis-aligned half-extents of a rotated ellipse.
    const hw = Math.hypot(el.a * Math.cos(th), el.b * Math.sin(th))
    const hh = Math.hypot(el.a * Math.sin(th), el.b * Math.cos(th))
    return { minX: el.center[0] - hw, maxX: el.center[0] + hw, minY: el.center[1] - hh, maxY: el.center[1] + hh }
  } else if (kind === 'spline') {
    const sp = entity as Spline
    // The control polygon bounds the curve (convex-hull property), so the four
    // control points give a conservative axis-aligned box.
    const xs = [sp.p1[0], sp.p2[0], sp.p3[0], sp.p4[0]]
    const ys = [sp.p1[1], sp.p2[1], sp.p3[1], sp.p4[1]]
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
  } else {
    const p = entity as PointEntity
    return { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y }
  }
}
