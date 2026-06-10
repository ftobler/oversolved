// Pure curve splitting for the area builder: cut a carrier curve at the
// parameters curveIntersect found into the sub-pieces the half-edge graph
// consumes. No topology / OCC deps -- a Rust/WASM-portable companion to
// curveIntersect.ts.
//
// A cubic Bezier sub-segment stays a cubic (de Casteljau), so a sliced spline is
// represented exactly by new control points -- not resampled. An ellipse cut at
// two eccentric angles yields the endpoints of the resulting elliptical arc.

export type Vec2 = [number, number]
export type BezierCtrl = [Vec2, Vec2, Vec2, Vec2]

function lerp(p: Vec2, q: Vec2, t: number): Vec2 {
  return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
}

/** Split a cubic Bezier at parameter t into (left over [0,t], right over [t,1]). */
export function splitBezierAt(c: BezierCtrl, t: number): [BezierCtrl, BezierCtrl] {
  const ab = lerp(c[0], c[1], t)
  const bc = lerp(c[1], c[2], t)
  const cd = lerp(c[2], c[3], t)
  const abc = lerp(ab, bc, t)
  const bcd = lerp(bc, cd, t)
  const abcd = lerp(abc, bcd, t)
  return [
    [c[0], ab, abc, abcd],
    [abcd, bcd, cd, c[3]],
  ]
}

/**
 * Control points of the cubic Bezier restricted to [t0, t1] (0 <= t0 < t1 <= 1).
 * Two de Casteljau cuts: trim the tail at t1, then trim the head of that piece.
 */
export function subdivideBezier(c: BezierCtrl, t0: number, t1: number): BezierCtrl {
  if (!(t1 > t0)) throw new Error("subdivideBezier: need t0 < t1")
  const [left] = splitBezierAt(c, t1)  // curve over [0, t1]
  if (t0 <= 0) return left
  const [, right] = splitBezierAt(left, t0 / t1)  // re-parameterized head cut
  return right
}

/** Point on an ellipse at eccentric angle phi (theta in degrees). */
export function ellipsePointAt(
  center: Vec2,
  a: number,
  b: number,
  thetaDeg: number,
  phi: number,
): Vec2 {
  const cr = Math.cos((thetaDeg * Math.PI) / 180)
  const sr = Math.sin((thetaDeg * Math.PI) / 180)
  const ax = a * Math.cos(phi)
  const ay = b * Math.sin(phi)
  return [center[0] + ax * cr - ay * sr, center[1] + ax * sr + ay * cr]
}
