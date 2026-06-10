// PURE GEOMETRY -- no Three.js, no React, no DOM.
// Least-squares cubic Bezier fitting, used to lower a sampled B-rep spline/NURBS
// edge into the 8-param cubic Bezier the solver and sketch model understand.

type P2 = [number, number]

function bezierAt(c: number[], t: number, d = 0): P2 {
  const [x1, y1, x2, y2, x3, y3, x4, y4] = c
  const mt = 1 - t
  if (d === 0) {
    const a = mt * mt * mt, b = 3 * mt * mt * t, e = 3 * mt * t * t, f = t * t * t
    return [a * x1 + b * x2 + e * x3 + f * x4, a * y1 + b * y2 + e * y3 + f * y4]
  }
  if (d === 1) {
    const a = 3 * mt * mt, b = 6 * mt * t, e = 3 * t * t
    return [a * (x2 - x1) + b * (x3 - x2) + e * (x4 - x3), a * (y2 - y1) + b * (y3 - y2) + e * (y4 - y3)]
  }
  const a = 6 * mt, b = 6 * t
  return [a * (x3 - 2 * x2 + x1) + b * (x4 - 2 * x3 + x2), a * (y3 - 2 * y2 + y1) + b * (y4 - 2 * y3 + y2)]
}

/** One Newton step on `(B(t)-p).B'(t)=0` to pull `t` toward the closest point. */
function refineParam(c: number[], p: P2, t: number): number {
  const b = bezierAt(c, t, 0)
  const d1 = bezierAt(c, t, 1)
  const d2 = bezierAt(c, t, 2)
  const w = [b[0] - p[0], b[1] - p[1]]
  const num = w[0] * d1[0] + w[1] * d1[1]
  const den = d1[0] * d1[0] + d1[1] * d1[1] + w[0] * d2[0] + w[1] * d2[1]
  if (Math.abs(den) < 1e-12) return t
  return Math.min(1, Math.max(0, t - num / den))
}

/** Cumulative chord-length parameterization of a polyline, normalized to [0,1].
 *  Falls back to a uniform split when the polyline has zero total length. */
function chordLengthParams(points: P2[]): number[] {
  const n = points.length
  const ts = new Array<number>(n).fill(0)
  let total = 0
  for (let i = 1; i < n; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    ts[i] = total
  }
  if (total <= 1e-12) {
    for (let i = 0; i < n; i++) ts[i] = n > 1 ? i / (n - 1) : 0
    return ts
  }
  for (let i = 0; i < n; i++) ts[i] /= total
  return ts
}

/**
 * Fit a cubic Bezier to `points`, returning the flat 8-param control polygon
 * `[x1, y1, x2, y2, x3, y3, x4, y4]`. The endpoints P1/P4 are pinned to the
 * first/last sample; the two interior controls P2/P3 are solved by least
 * squares against a chord-length parameterization. Returns null for fewer
 * than two points.
 */
export function fitCubicBezier(points: P2[]): number[] | null {
  if (points.length < 2) return null
  const p1 = points[0]
  const p4 = points[points.length - 1]

  // With only two samples there is nothing to fit: place the controls at the
  // chord thirds so the curve is the straight segment.
  if (points.length === 2) {
    return [
      p1[0], p1[1],
      p1[0] + (p4[0] - p1[0]) / 3, p1[1] + (p4[1] - p1[1]) / 3,
      p1[0] + 2 * (p4[0] - p1[0]) / 3, p1[1] + 2 * (p4[1] - p1[1]) / 3,
      p4[0], p4[1],
    ]
  }

  const straight = (): number[] => [
    p1[0], p1[1],
    p1[0] + (p4[0] - p1[0]) / 3, p1[1] + (p4[1] - p1[1]) / 3,
    p1[0] + 2 * (p4[0] - p1[0]) / 3, p1[1] + 2 * (p4[1] - p1[1]) / 3,
    p4[0], p4[1],
  ]

  // Least-squares solve for the two interior controls at fixed endpoints, given
  // a parameter per sample. The same 2x2 basis matrix serves both coordinates.
  const solveControls = (ts: number[]): number[] | null => {
    let a11 = 0, a12 = 0, a22 = 0
    let bx1 = 0, bx2 = 0, by1 = 0, by2 = 0
    for (let i = 0; i < points.length; i++) {
      const t = ts[i]
      const mt = 1 - t
      const b0 = mt * mt * mt
      const b1 = 3 * mt * mt * t
      const b2 = 3 * mt * t * t
      const b3 = t * t * t
      a11 += b1 * b1
      a12 += b1 * b2
      a22 += b2 * b2
      const rx = points[i][0] - b0 * p1[0] - b3 * p4[0]
      const ry = points[i][1] - b0 * p1[1] - b3 * p4[1]
      bx1 += rx * b1
      bx2 += rx * b2
      by1 += ry * b1
      by2 += ry * b2
    }
    const det = a11 * a22 - a12 * a12
    if (Math.abs(det) < 1e-12) return null
    const inv = 1 / det
    return [
      p1[0], p1[1],
      (a22 * bx1 - a12 * bx2) * inv, (a22 * by1 - a12 * by2) * inv,
      (a11 * bx2 - a12 * bx1) * inv, (a11 * by2 - a12 * by1) * inv,
      p4[0], p4[1],
    ]
  }

  let ts = chordLengthParams(points)
  let controls = solveControls(ts)
  if (!controls) return straight()  // degenerate parameterization

  // Reparameterize and refit until the control polygon stops moving: chord
  // length is only an approximation of the true Bezier parameter, so Newton-
  // projecting each sample onto the current fit and resolving tightens the
  // result substantially (a steep arch needs ~10 passes to converge).
  for (let iter = 0; iter < 16; iter++) {
    const refined = ts.map((t, i) => refineParam(controls!, points[i], t))
    const next = solveControls(refined)
    if (!next) break
    const moved = Math.max(
      ...next.map((v, i) => Math.abs(v - controls![i])),
    )
    ts = refined
    controls = next
    if (moved < 1e-7) break
  }
  return controls
}
