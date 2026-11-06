// PURE -- no doc mutation, no Three.js, no icons. The two polyline samplers the
// profile builder and the even-odd probes share. They live outside
// sketchHelpers because that module eagerly loads the icon SVGs for the editor
// (a Vite-only import.meta.glob), and the value rules reach a sampler under
// plain Node through the CLI.
import type { Point } from '@/types/cad'

function allFinite(...vals: number[]): boolean {
  return vals.every(v => Number.isFinite(v))
}

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
