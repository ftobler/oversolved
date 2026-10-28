/**
 * The TypeScript mirror of the canonical Rust interpolating spline
 * (`sketch-solver/src/fit_spline.rs`).
 *
 * It exists for rendering, picking, snapping, the draw preview and the MCP
 * authoring sugar ONLY. The solver residuals and the area builder use the Rust
 * one; the kernel's topology edges come from there. The two are pinned to the
 * same OCP golden fixture (`sketch-solver/src/fit_spline/golden.json`), which
 * `fitSpline.test.ts` reads, so a drift fails a test on one side or the other.
 *
 * The construction is the clamped C2 cubic spline OCP's `GeomAPI_Interpolate`
 * builds: cumulative chord parameters, Lagrange end derivatives (or the stored
 * handle), the tridiagonal interior system, and one Hermite cubic per span.
 */

export type Pt = [number, number]

/** Which end handles a fit spline stores. */
export type FitSplineHandles = 'start' | 'end' | 'both'

export interface ClosestPoint {
  u: number
  point: Pt
  distance: number
  signed: number
}

export interface FitSplineCurve {
  /** The fit points, in order. */
  readonly points: readonly Pt[]
  /** The chord parameter at each fit point. */
  readonly knots: readonly number[]
  /** The derivative at each fit point. */
  readonly derivatives: readonly Pt[]
  readonly pieceCount: number
  piece(i: number): [Pt, Pt, Pt, Pt]
  /** The C0 cubic Bezier chain: `3 (N - 1) + 1` poles sharing each joint. */
  poles(): Pt[]
  eval(u: number): Pt
  deriv(u: number): Pt
  closest(p: Pt): ClosestPoint
  /** The chain over `[u0, u1]`, as poles and knots for an OCC B-spline. */
  subChain(u0: number, u1: number): { poles: Pt[]; knots: number[] }
  /** The piece-space parameter (`piece + t`) as a chord parameter. */
  uAt(s: number): number
}

const MAX_FIT_POINTS = 64

export class FitSplineError extends Error {}

function chordLength(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/** Cumulative chord length, the parameter OCP's interpolate builds. */
export function chordParams(points: readonly Pt[]): number[] {
  const us = [0]
  for (let i = 1; i < points.length; i++) us.push(us[i - 1] + chordLength(points[i - 1], points[i]))
  return us
}

/** Evaluate a cubic Bezier at `t`. */
export function bezierEval(ctrl: readonly Pt[], t: number): Pt {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return [
    a * ctrl[0][0] + b * ctrl[1][0] + c * ctrl[2][0] + d * ctrl[3][0],
    a * ctrl[0][1] + b * ctrl[1][1] + c * ctrl[2][1] + d * ctrl[3][1],
  ]
}

/** First derivative of a cubic Bezier with respect to `t`. */
export function bezierDeriv(ctrl: readonly Pt[], t: number): Pt {
  const mt = 1 - t
  return [
    3 * mt * mt * (ctrl[1][0] - ctrl[0][0]) + 6 * mt * t * (ctrl[2][0] - ctrl[1][0]) + 3 * t * t * (ctrl[3][0] - ctrl[2][0]),
    3 * mt * mt * (ctrl[1][1] - ctrl[0][1]) + 6 * mt * t * (ctrl[2][1] - ctrl[1][1]) + 3 * t * t * (ctrl[3][1] - ctrl[2][1]),
  ]
}

function bezierDeriv2(ctrl: readonly Pt[], t: number): Pt {
  const mt = 1 - t
  return [
    6 * mt * (ctrl[2][0] - 2 * ctrl[1][0] + ctrl[0][0]) + 6 * t * (ctrl[3][0] - 2 * ctrl[2][0] + ctrl[1][0]),
    6 * mt * (ctrl[2][1] - 2 * ctrl[1][1] + ctrl[0][1]) + 6 * t * (ctrl[3][1] - 2 * ctrl[2][1] + ctrl[1][1]),
  ]
}

/** Derivative at `x` of the polynomial interpolating `(us, ps)`. */
export function lagrangeDerivative(us: readonly number[], ps: readonly Pt[], x: number): Pt {
  const node = us.findIndex(u => Math.abs(u - x) <= 1e-12 * Math.max(1, Math.abs(x)))
  const out: Pt = [0, 0]
  for (let j = 0; j < ps.length; j++) {
    let weight: number
    if (j === node) {
      let sum = 0
      for (let a = 0; a < us.length; a++) {
        if (a === node) continue
        let product = 1
        for (let m = 0; m < us.length; m++) {
          if (m !== node && m !== a) product *= us[node] - us[m]
        }
        sum += product
      }
      let denominator = 1
      for (let m = 0; m < us.length; m++) {
        if (m !== node) denominator *= us[node] - us[m]
      }
      weight = sum / denominator
    } else if (node >= 0) {
      // x IS one of the nodes, so the general form divides by zero. The
      // derivative of L_j at another node is the product over the remaining
      // nodes, with no division by the vanishing factor.
      let numerator = 1
      for (let m = 0; m < us.length; m++) {
        if (m !== j && m !== node) numerator *= us[node] - us[m]
      }
      let denominator = 1
      for (let m = 0; m < us.length; m++) {
        if (m !== j) denominator *= us[j] - us[m]
      }
      weight = numerator / denominator
    } else {
      let numerator = 1
      for (let m = 0; m < us.length; m++) {
        if (m !== j) numerator *= x - us[m]
      }
      let denominator = 1
      for (let m = 0; m < us.length; m++) {
        if (m !== j) denominator *= us[j] - us[m]
      }
      let slope = 0
      for (let p = 0; p < us.length; p++) {
        if (p !== j) slope += 1 / (x - us[p])
      }
      weight = (numerator * slope) / denominator
    }
    out[0] += weight * ps[j][0]
    out[1] += weight * ps[j][1]
  }
  return out
}

function endDerivative(points: readonly Pt[], knots: readonly number[], start: boolean): Pt {
  const n = points.length
  const count = Math.min(4, n)
  if (start) {
    return lagrangeDerivative(knots.slice(0, count), points.slice(0, count), knots[0])
  }
  return lagrangeDerivative(knots.slice(n - count), points.slice(n - count), knots[n - 1])
}

/** The derivative an absolute handle point stores (D2). */
export function tangentFromHandle(point: Pt, handle: Pt, span: number): Pt {
  return [(3 * (handle[0] - point[0])) / span, (3 * (handle[1] - point[1])) / span]
}

/** The absolute handle point that stores `tangent` as an end derivative (D2). */
export function handleFromTangent(point: Pt, tangent: Pt, span: number): Pt {
  return [point[0] + (span * tangent[0]) / 3, point[1] + (span * tangent[1]) / 3]
}

/** The interior derivatives, Thomas algorithm per coordinate. */
function solveInterior(points: readonly Pt[], knots: readonly number[], derivatives: Pt[]): void {
  const n = points.length
  const m = Math.max(0, n - 2)
  if (m === 0) return
  const sub: number[] = []
  const diag: number[] = []
  const sup: number[] = []
  const rhs: Pt[] = []
  for (let row = 0; row < m; row++) {
    const i = row + 1
    const hPrev = knots[i] - knots[i - 1]
    const hNext = knots[i + 1] - knots[i]
    sub.push(hNext)
    diag.push(2 * (hPrev + hNext))
    sup.push(hPrev)
    rhs.push([
      3 * ((hNext * (points[i][0] - points[i - 1][0])) / hPrev + (hPrev * (points[i + 1][0] - points[i][0])) / hNext),
      3 * ((hNext * (points[i][1] - points[i - 1][1])) / hPrev + (hPrev * (points[i + 1][1] - points[i][1])) / hNext),
    ])
  }
  for (let c = 0; c < 2; c++) {
    rhs[0][c] -= sub[0] * derivatives[0][c]
    rhs[m - 1][c] -= sup[m - 1] * derivatives[n - 1][c]
  }
  const cprime: number[] = []
  const dprime: Pt[] = []
  cprime.push(sup[0] / diag[0])
  dprime.push([rhs[0][0] / diag[0], rhs[0][1] / diag[0]])
  for (let row = 1; row < m; row++) {
    const denominator = diag[row] - sub[row] * cprime[row - 1]
    cprime.push(sup[row] / denominator)
    dprime.push([
      (rhs[row][0] - sub[row] * dprime[row - 1][0]) / denominator,
      (rhs[row][1] - sub[row] * dprime[row - 1][1]) / denominator,
    ])
  }
  const x: Pt[] = new Array(m)
  x[m - 1] = dprime[m - 1]
  for (let row = m - 2; row >= 0; row--) {
    x[row] = [dprime[row][0] - cprime[row] * x[row + 1][0], dprime[row][1] - cprime[row] * x[row + 1][1]]
  }
  for (let row = 0; row < m; row++) derivatives[row + 1] = x[row]
}

/**
 * Interpolate the fit points. A zero chord span is refused unless `minSpan` is
 * positive (the solver floors it there; the UI and authoring use 0 and refuse).
 */
export function interpolateFitSpline(
  points: readonly Pt[],
  handleStart?: Pt | null,
  handleEnd?: Pt | null,
  minSpan = 0,
): FitSplineCurve {
  const n = points.length
  if (n < 2) throw new FitSplineError('fit spline needs at least 2 fit points')
  if (n > MAX_FIT_POINTS) throw new FitSplineError(`fit spline has more than ${MAX_FIT_POINTS} fit points`)
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new FitSplineError('fit spline has a non-finite point')
  }
  for (const h of [handleStart, handleEnd]) {
    if (h && (!Number.isFinite(h[0]) || !Number.isFinite(h[1]))) {
      throw new FitSplineError('fit spline has a non-finite handle')
    }
  }
  const knots: number[] = [0]
  for (let i = 1; i < n; i++) {
    const chord = chordLength(points[i - 1], points[i])
    if (chord <= 0 && minSpan <= 0) throw new FitSplineError(`fit spline has coincident consecutive fit points ${i - 1},${i}`)
    knots.push(knots[i - 1] + Math.max(chord, minSpan))
  }
  const derivatives: Pt[] = new Array(n)
  derivatives[0] = handleStart ? tangentFromHandle(points[0], handleStart, knots[1] - knots[0]) : endDerivative(points, knots, true)
  if (handleEnd) {
    const d = tangentFromHandle(points[n - 1], handleEnd, knots[n - 1] - knots[n - 2])
    derivatives[n - 1] = [-d[0], -d[1]]
  } else {
    derivatives[n - 1] = endDerivative(points, knots, false)
  }
  solveInterior(points, knots, derivatives)
  return makeCurve(points, knots, derivatives)
}

function makeCurve(points: readonly Pt[], knots: readonly number[], derivatives: readonly Pt[]): FitSplineCurve {
  const pieceCount = knots.length - 1
  const piece = (i: number): [Pt, Pt, Pt, Pt] => {
    const h = knots[i + 1] - knots[i]
    const d0 = derivatives[i]
    const d1 = derivatives[i + 1]
    return [
      [points[i][0], points[i][1]],
      [points[i][0] + (h * d0[0]) / 3, points[i][1] + (h * d0[1]) / 3],
      [points[i + 1][0] - (h * d1[0]) / 3, points[i + 1][1] - (h * d1[1]) / 3],
      [points[i + 1][0], points[i + 1][1]],
    ]
  }
  const pieceAt = (u: number): number => {
    if (u <= knots[0]) return 0
    if (u >= knots[knots.length - 1]) return pieceCount - 1
    let lo = 0
    let hi = knots.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (knots[mid] <= u) lo = mid
      else hi = mid
    }
    return Math.min(lo, pieceCount - 1)
  }
  const evalAt = (u: number): Pt => {
    const i = pieceAt(u)
    const h = knots[i + 1] - knots[i]
    const t = h > 0 ? Math.min(1, Math.max(0, (u - knots[i]) / h)) : 0
    return bezierEval(piece(i), t)
  }
  const derivAt = (u: number): Pt => {
    const i = pieceAt(u)
    const h = knots[i + 1] - knots[i]
    const t = h > 0 ? Math.min(1, Math.max(0, (u - knots[i]) / h)) : 0
    const d = bezierDeriv(piece(i), t)
    return h > 0 ? [d[0] / h, d[1] / h] : d
  }
  const closest = (p: Pt): ClosestPoint => {
    let best: ClosestPoint = { u: knots[0], point: evalAt(knots[0]), distance: Infinity, signed: Infinity }
    for (let i = 0; i < pieceCount; i++) {
      const ctrl = piece(i)
      const t = bezierClosestT(ctrl, p)
      const point = bezierEval(ctrl, t)
      const w: Pt = [p[0] - point[0], p[1] - point[1]]
      const distance = Math.hypot(w[0], w[1])
      if (distance < best.distance) {
        const d1 = bezierDeriv(ctrl, t)
        const signed = d1[0] * w[1] - d1[1] * w[0] < 0 ? -distance : distance
        best = { u: knots[i] + t * (knots[i + 1] - knots[i]), point, distance, signed }
      }
    }
    return best
  }
  const poles = (): Pt[] => {
    const out: Pt[] = []
    for (let i = 0; i < pieceCount; i++) {
      const ctrl = piece(i)
      if (i === 0) out.push(ctrl[0])
      out.push(ctrl[1], ctrl[2], ctrl[3])
    }
    return out
  }
  const uAt = (s: number): number => {
    const i = Math.min(Math.max(0, Math.floor(s)), pieceCount - 1)
    const t = Math.min(1, Math.max(0, s - i))
    return knots[i] + t * (knots[i + 1] - knots[i])
  }
  const subChain = (u0: number, u1: number): { poles: Pt[]; knots: number[] } => {
    const [lo, hi] = u0 <= u1 ? [u0, u1] : [u1, u0]
    if (lo <= knots[0] && hi >= knots[knots.length - 1]) return { poles: poles(), knots: knots.slice() }
    const outPoles: Pt[] = []
    const outKnots: number[] = [lo]
    for (let i = 0; i < pieceCount; i++) {
      const a = knots[i]
      const b = knots[i + 1]
      if (b <= lo || a >= hi) continue
      const t0 = Math.min(1, Math.max(0, (lo - a) / (b - a)))
      const t1 = Math.min(1, Math.max(0, (hi - a) / (b - a)))
      const ctrl = splitBezier(piece(i), t0, t1)
      if (outPoles.length === 0) outPoles.push(...ctrl)
      else outPoles.push(ctrl[1], ctrl[2], ctrl[3])
      outKnots.push(Math.min(hi, b))
    }
    return { poles: outPoles, knots: outKnots }
  }
  return {
    points,
    knots,
    derivatives,
    pieceCount,
    piece,
    poles,
    eval: evalAt,
    deriv: derivAt,
    closest,
    subChain,
    uAt,
  }
}

function bezierClosestT(ctrl: readonly Pt[], p: Pt): number {
  const SAMPLES = 24
  const dist2 = (t: number): number => {
    const b = bezierEval(ctrl, t)
    return (p[0] - b[0]) ** 2 + (p[1] - b[1]) ** 2
  }
  let bestT = 0
  let bestD = Infinity
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES
    const d = dist2(t)
    if (d < bestD) {
      bestD = d
      bestT = t
    }
  }
  let t = bestT
  for (let k = 0; k < 8; k++) {
    const b = bezierEval(ctrl, t)
    const d1 = bezierDeriv(ctrl, t)
    const d2 = bezierDeriv2(ctrl, t)
    const w: Pt = [p[0] - b[0], p[1] - b[1]]
    const f = w[0] * d1[0] + w[1] * d1[1]
    const fp = -(d1[0] * d1[0] + d1[1] * d1[1]) + w[0] * d2[0] + w[1] * d2[1]
    if (Math.abs(fp) < 1e-12) break
    t = Math.min(1, Math.max(0, t - f / fp))
  }
  return t
}

function deCasteljau(ctrl: readonly Pt[], t: number): [[Pt, Pt, Pt, Pt], [Pt, Pt, Pt, Pt]] {
  const lerp = (a: Pt, b: Pt): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const p01 = lerp(ctrl[0], ctrl[1])
  const p12 = lerp(ctrl[1], ctrl[2])
  const p23 = lerp(ctrl[2], ctrl[3])
  const p012 = lerp(p01, p12)
  const p123 = lerp(p12, p23)
  const p = lerp(p012, p123)
  return [
    [ctrl[0], p01, p012, p],
    [p, p123, p23, ctrl[3]],
  ]
}

/** The part of one cubic between `t0 <= t1`, via de Casteljau. */
export function splitBezier(ctrl: readonly Pt[], t0: number, t1: number): [Pt, Pt, Pt, Pt] {
  if (t1 < t0) {
    const r = splitBezier(ctrl, t1, t0)
    return [r[3], r[2], r[1], r[0]]
  }
  const left = deCasteljau(ctrl, t1)[0]
  if (t0 <= 0) return left
  return deCasteljau(left, Math.min(1, Math.max(0, t0 / t1)))[1]
}

/**
 * Port of OCCT `GeomAPI_Interpolate::ScaleTangents`: each given tangent keeps
 * its direction and takes the magnitude of the Lagrange interpolant through the
 * nearest `degree + 1` points, where degree is 1 for two points and 2 otherwise.
 *
 * This is the `scale=True` CadQuery default. It runs ONCE in the authoring
 * sugar; the document stores the resulting handle point (D2), so a later
 * fit-point edit does not re-scale it.
 */
export function scaleTangents(points: readonly Pt[], tangents: readonly (Pt | null)[]): (Pt | null)[] {
  const n = points.length
  if (n < 2) return tangents.slice()
  const degree = n === 2 ? 1 : 2
  const us = chordParams(points)
  // Two accepted spellings: one entry per point (null where unconstrained), or
  // the authoring pair `[start, end]`. The pair is what the document and the
  // mutation sugar carry; the per-point array is CadQuery's full form.
  const out: (Pt | null)[] = new Array(n).fill(null)
  if (tangents.length === n) {
    for (let i = 0; i < n; i++) out[i] = tangents[i] ? [tangents[i]![0], tangents[i]![1]] : null
  } else if (tangents.length === 2) {
    out[0] = tangents[0] ? [tangents[0][0], tangents[0][1]] : null
    out[n - 1] = tangents[1] ? [tangents[1][0], tangents[1][1]] : null
  } else {
    return tangents.slice()
  }
  // OCCT's `ScaleTangents` advances the Lagrange window only when it meets a
  // FLAGGED tangent after the first. With the authoring two-end form (start and
  // end flagged, nothing between) both ends therefore evaluate the FIRST
  // `degree + 1` points; a per-point tangent array advances window by window.
  let index = 0
  let first = true
  for (let i = 0; i < n; i++) {
    const tangent = out[i]
    if (!tangent) continue
    const windowUs = us.slice(index, index + degree + 1)
    const windowPs = points.slice(index, index + degree + 1)
    const derivative = lagrangeDerivative(windowUs, windowPs, us[i])
    const tangentMag = Math.abs(tangent[0]) + Math.abs(tangent[1])
    const derivativeMag = Math.abs(derivative[0]) + Math.abs(derivative[1])
    if (tangentMag <= 0) continue
    const ratio = derivativeMag / tangentMag
    out[i] = [tangent[0] * ratio, tangent[1] * ratio]
    if (!first) index += 1
    first = false
    index = Math.min(index, n - 1 - degree)
  }
  return out
}

/**
 * Convert an authored tangent pair into the absolute handles the document
 * stores. `scale` is CadQuery's default; the caller passes `false` to keep the
 * magnitudes.
 */
export function handlesFromTangents(
  points: readonly Pt[],
  tangents: readonly (Pt | null)[],
  scale = true,
): { handleStart?: Pt; handleEnd?: Pt } {
  if (points.length < 2) return {}
  const n = points.length
  const perPoint: (Pt | null)[] = new Array(n).fill(null)
  if (tangents.length === n) {
    for (let i = 0; i < n; i++) perPoint[i] = tangents[i]
  } else if (tangents.length === 2) {
    perPoint[0] = tangents[0]
    perPoint[n - 1] = tangents[1]
  } else {
    return {}
  }
  const effective = scale ? scaleTangents(points, perPoint) : perPoint
  const us = chordParams(points)
  const result: { handleStart?: Pt; handleEnd?: Pt } = {}
  const first = effective[0]
  if (first) result.handleStart = handleFromTangent(points[0], first, us[1] - us[0])
  const last = effective[effective.length - 1]
  if (last) {
    // The end handle is the last piece's THIRD control point, so the sign is
    // the opposite of the start handle's (D2: D = 3 (P - c2) / h).
    const n = points.length
    const span = us[n - 1] - us[n - 2]
    result.handleEnd = [points[n - 1][0] - (span * last[0]) / 3, points[n - 1][1] - (span * last[1]) / 3]
  }
  return result
}

/** Decode a flat param block into a curve. `handles` mirrors the document field. */
export function fitSplineFromParams(params: readonly number[], handles?: FitSplineHandles | null): FitSplineCurve {
  const handleCount = handles === 'both' ? 2 : handles === 'start' || handles === 'end' ? 1 : 0
  const remaining = params.length - 2 * handleCount
  if (remaining < 4 || remaining % 2 !== 0) throw new FitSplineError(`fit spline param count ${params.length} is not 2N + ${2 * handleCount}`)
  const n = remaining / 2
  if (n > MAX_FIT_POINTS) throw new FitSplineError(`fit spline has more than ${MAX_FIT_POINTS} fit points`)
  const points: Pt[] = []
  for (let i = 0; i < n; i++) points.push([params[2 * i], params[2 * i + 1]])
  let next = 2 * n
  const handleStart = handles === 'start' || handles === 'both' ? ([params[next], params[next + 1]] as Pt) : null
  if (handleStart) next += 2
  const handleEnd = handles === 'end' || handles === 'both' ? ([params[next], params[next + 1]] as Pt) : null
  return interpolateFitSpline(points, handleStart, handleEnd)
}

/** Evaluate a C0 cubic chain at chord parameter `u`. Used by the boundary
 *  tessellator, which receives the topology edge's poles and knots. */
export function chainPoint(poles: readonly Pt[], knots: readonly number[], u: number): Pt {
  const pieceCount = knots.length - 1
  let i = 0
  if (u >= knots[knots.length - 1]) i = pieceCount - 1
  else if (u > knots[0]) {
    let lo = 0
    let hi = knots.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (knots[mid] <= u) lo = mid
      else hi = mid
    }
    i = Math.min(lo, pieceCount - 1)
  }
  const h = knots[i + 1] - knots[i]
  const t = h > 0 ? Math.min(1, Math.max(0, (u - knots[i]) / h)) : 0
  return bezierEval([poles[3 * i], poles[3 * i + 1], poles[3 * i + 2], poles[3 * i + 3]], t)
}

/** `n` interior points along a chain, in traversal order. */
export function chainSamples(poles: readonly Pt[], knots: readonly number[], n: number): Pt[] {
  const u0 = knots[0]
  const u1 = knots[knots.length - 1]
  const out: Pt[] = []
  for (let k = 1; k <= n; k++) out.push(chainPoint(poles, knots, u0 + ((u1 - u0) * k) / (n + 1)))
  return out
}

/** A rendered polyline through the curve, `n + 1` points inclusive. Returns []
 *  for a degenerate point list (the caller hides the entity). */
export function fitSplinePolyline(
  points: readonly Pt[],
  handleStart?: Pt | null,
  handleEnd?: Pt | null,
  n = 64,
): Pt[] {
  if (points.length < 2) return []
  let curve: FitSplineCurve
  try {
    curve = interpolateFitSpline(points, handleStart, handleEnd)
  } catch {
    return []
  }
  const u0 = curve.knots[0]
  const u1 = curve.knots[curve.knots.length - 1]
  const out: Pt[] = []
  for (let k = 0; k <= n; k++) out.push(curve.eval(u0 + ((u1 - u0) * k) / n))
  return out
}
