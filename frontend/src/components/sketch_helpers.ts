import * as THREE from 'three'
import type { Entity, LineSegment, Circle, Arc, PointEntity, Point } from '../types/cad'
import { getEntityKind } from '../types/cad'
import { RENDER_KIND_TO_ICON } from '../registry'

/** Check if all values in a tuple are finite numbers. */
export function allFinite(...vals: number[]): boolean {
  return vals.every(v => Number.isFinite(v))
}

/** Convert a 2D Point to a 3D tuple, or return null if any value is NaN/non-finite. */
export function pointTo3D(p: Point): [number, number, number] | null {
  if (!allFinite(p[0], p[1])) return null
  return [p[0], p[1], 0]
}

export const COLOR_CONSTRAINT = '#ffd54f'

export const ICON_SIZE = 22
export const ICON_COLS = 3

export const iconModules = import.meta.glob('../assets/icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

// Derived from the constraint registry — maps render kind to icon filename.
export const SYMBOL_TO_ICON: Readonly<Record<string, string>> = RENDER_KIND_TO_ICON

export function getIconUrl(kind: string): string | undefined {
  const name = SYMBOL_TO_ICON[kind]
  if (!name) return undefined
  return iconModules[`../assets/icons/${name}.svg`]
}

// World units per pixel for an orthographic camera.
export function p2w(camera: THREE.Camera): number {
  return 'zoom' in camera ? 1 / (camera as THREE.OrthographicCamera).zoom : 1
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
  } else {
    const p = entity as PointEntity
    return { minX: p.x, maxX: p.x, minY: p.y, maxY: p.y }
  }
}
