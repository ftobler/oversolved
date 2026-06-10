// Pure curve-curve intersection for the sketch area builder. Plain numbers in,
// intersection points + per-curve parameters out -- NO topology, OCC, or query
// dependencies. This is the one piece earmarked for a later Rust/WASM lift
// (solver_arch.user.md "The area builder belongs in Rust/WASM too"), so it is
// kept self-contained and rule-based.
//
// Parameter conventions returned in each Hit (tA on curve a, tB on curve b):
//   line     t in [0, 1]            along p0 -> p1
//   circle   angle in [0, 2*pi)     geometric atan2 from the center
//   ellipse  ecc. angle in [0, 2*pi) the Geom_Ellipse parameter phi, where the
//            point is center + Rot(theta) * (a cos phi, b sin phi)
//   bezier   t in [0, 1]
//
// Robustness rule: numeric pairs report only genuine sign-change crossings. A
// tangency (a touch with no sign change) yields no point, which is exactly what
// the area builder wants -- a single grazing contact must not split a curve.

import { TOL_TOPOLOGY_MERGE } from "./solverConstants"

export type Vec2 = [number, number]

export type Curve =
  | { kind: "line"; p0: Vec2; p1: Vec2 }
  | { kind: "circle"; c: Vec2; r: number }
  | { kind: "ellipse"; c: Vec2; a: number; b: number; theta: number }
  | { kind: "bezier"; p0: Vec2; c1: Vec2; c2: Vec2; p3: Vec2 }

export interface Hit {
  point: Vec2
  tA: number
  tB: number
}

const TWO_PI = 2 * Math.PI
const POINT_MERGE = TOL_TOPOLOGY_MERGE  // two hits closer than this are the same

function norm2pi(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

// ─── parametric evaluation ───

function ellipseAt(e: Extract<Curve, { kind: "ellipse" }>, phi: number): Vec2 {
  const cr = Math.cos((e.theta * Math.PI) / 180)
  const sr = Math.sin((e.theta * Math.PI) / 180)
  const ax = e.a * Math.cos(phi)
  const ay = e.b * Math.sin(phi)
  return [e.c[0] + ax * cr - ay * sr, e.c[1] + ax * sr + ay * cr]
}

function bezierAt(b: Extract<Curve, { kind: "bezier" }>, t: number): Vec2 {
  const mt = 1 - t
  const w0 = mt * mt * mt
  const w1 = 3 * mt * mt * t
  const w2 = 3 * mt * t * t
  const w3 = t * t * t
  return [
    w0 * b.p0[0] + w1 * b.c1[0] + w2 * b.c2[0] + w3 * b.p3[0],
    w0 * b.p0[1] + w1 * b.c1[1] + w2 * b.c2[1] + w3 * b.p3[1],
  ]
}

// ─── recover a curve's parameter from a point known to lie on it ───

function paramOf(curve: Curve, p: Vec2): number {
  if (curve.kind === "line") {
    const dx = curve.p1[0] - curve.p0[0]
    const dy = curve.p1[1] - curve.p0[1]
    const len2 = dx * dx + dy * dy
    if (len2 < 1e-18) return 0
    return ((p[0] - curve.p0[0]) * dx + (p[1] - curve.p0[1]) * dy) / len2
  }
  if (curve.kind === "circle") {
    return norm2pi(Math.atan2(p[1] - curve.c[1], p[0] - curve.c[0]))
  }
  if (curve.kind === "ellipse") {
    const cr = Math.cos((curve.theta * Math.PI) / 180)
    const sr = Math.sin((curve.theta * Math.PI) / 180)
    const dx = p[0] - curve.c[0]
    const dy = p[1] - curve.c[1]
    // Un-rotate into the ellipse's local frame, then the eccentric angle is
    // atan2(y'/b, x'/a) (NOT the geometric angle).
    const xl = dx * cr + dy * sr
    const yl = -dx * sr + dy * cr
    return norm2pi(Math.atan2(yl / curve.b, xl / curve.a))
  }
  // bezier: not recoverable in closed form; callers that pair a bezier as the
  // "other" curve always obtain its parameter directly (scanning / subdivision).
  return Number.NaN
}

// ─── implicit residual of a conic at a point (zero on the curve) ───

function conicResidual(curve: Curve): (p: Vec2) => number {
  if (curve.kind === "circle") {
    return (p) => {
      const dx = p[0] - curve.c[0]
      const dy = p[1] - curve.c[1]
      return dx * dx + dy * dy - curve.r * curve.r
    }
  }
  if (curve.kind === "ellipse") {
    const cr = Math.cos((curve.theta * Math.PI) / 180)
    const sr = Math.sin((curve.theta * Math.PI) / 180)
    return (p) => {
      const dx = p[0] - curve.c[0]
      const dy = p[1] - curve.c[1]
      const xl = dx * cr + dy * sr
      const yl = -dx * sr + dy * cr
      return (xl * xl) / (curve.a * curve.a) + (yl * yl) / (curve.b * curve.b) - 1
    }
  }
  throw new Error("conicResidual: not a conic")
}

// ─── 1-D root finding by dense sampling + bisection (sign-change only) ───

const SCAN_SAMPLES = 512
const BISECT_ITERS = 60

function bisect(g: (t: number) => number, lo: number, hi: number): number {
  let a = lo
  let b = hi
  let ga = g(a)
  for (let i = 0; i < BISECT_ITERS; i++) {
    const m = 0.5 * (a + b)
    const gm = g(m)
    if (gm === 0) return m
    if (ga * gm < 0) {
      b = m
    } else {
      a = m
      ga = gm
    }
  }
  return 0.5 * (a + b)
}

/**
 * Roots of g over [t0, t1] found by scanning for sign changes and refining. For
 * periodic curves pass the full period [0, 2pi); the seam is covered because the
 * endpoints coincide (g(0) == g(2pi)).
 */
function scanRoots(g: (t: number) => number, t0: number, t1: number): number[] {
  const roots: number[] = []
  const step = (t1 - t0) / SCAN_SAMPLES
  let prevT = t0
  let prevG = g(prevT)
  for (let i = 1; i <= SCAN_SAMPLES; i++) {
    const curT = t0 + i * step
    const curG = g(curT)
    if (prevG === 0) {
      roots.push(prevT)
    } else if (prevG * curG < 0) {
      roots.push(bisect(g, prevT, curT))
    }
    prevT = curT
    prevG = curG
  }
  return roots
}

// ─── point de-dup ───

function dedupHits(hits: Hit[]): Hit[] {
  const out: Hit[] = []
  for (const h of hits) {
    if (
      out.some(
        (o) =>
          Math.abs(o.point[0] - h.point[0]) < POINT_MERGE &&
          Math.abs(o.point[1] - h.point[1]) < POINT_MERGE,
      )
    ) {
      continue
    }
    out.push(h)
  }
  return out
}

// ─── closed-form pairs ───

function lineLine(
  a: Extract<Curve, { kind: "line" }>,
  b: Extract<Curve, { kind: "line" }>,
): Vec2[] {
  const dx1 = a.p1[0] - a.p0[0]
  const dy1 = a.p1[1] - a.p0[1]
  const dx2 = b.p1[0] - b.p0[0]
  const dy2 = b.p1[1] - b.p0[1]
  const det = dx1 * dy2 - dy1 * dx2
  if (Math.abs(det) < 1e-12) return []
  const dx3 = b.p0[0] - a.p0[0]
  const dy3 = b.p0[1] - a.p0[1]
  const t = (dx3 * dy2 - dy3 * dx2) / det
  const u = (dx3 * dy1 - dy3 * dx1) / det
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return []
  return [[a.p0[0] + t * dx1, a.p0[1] + t * dy1]]
}

/** Line vs full circle: closed-form quadratic, segment-clamped. */
function lineCircle(
  l: Extract<Curve, { kind: "line" }>,
  c: Extract<Curve, { kind: "circle" }>,
): Vec2[] {
  const dx = l.p1[0] - l.p0[0]
  const dy = l.p1[1] - l.p0[1]
  const fx = l.p0[0] - c.c[0]
  const fy = l.p0[1] - c.c[1]
  const A = dx * dx + dy * dy
  if (A < 1e-18) return []
  const B = 2 * (fx * dx + fy * dy)
  const C = fx * fx + fy * fy - c.r * c.r
  const disc = B * B - 4 * A * C
  if (disc < 0) return []
  const sd = Math.sqrt(disc)
  const pts: Vec2[] = []
  for (const sign of [-1, 1]) {
    const t = (-B + sign * sd) / (2 * A)
    if (t >= -1e-9 && t <= 1 + 1e-9) pts.push([l.p0[0] + t * dx, l.p0[1] + t * dy])
  }
  return pts
}

/**
 * Line vs ellipse: map the line into the ellipse's local unit-circle space
 * (un-rotate, scale by 1/a, 1/b), intersect the unit circle in closed form, then
 * map the hit points back to world. Exact, no iteration.
 */
function lineEllipse(
  l: Extract<Curve, { kind: "line" }>,
  e: Extract<Curve, { kind: "ellipse" }>,
): Vec2[] {
  const cr = Math.cos((e.theta * Math.PI) / 180)
  const sr = Math.sin((e.theta * Math.PI) / 180)
  const toLocal = (p: Vec2): Vec2 => {
    const dx = p[0] - e.c[0]
    const dy = p[1] - e.c[1]
    return [(dx * cr + dy * sr) / e.a, (-dx * sr + dy * cr) / e.b]
  }
  const q0 = toLocal(l.p0)
  const q1 = toLocal(l.p1)
  const dx = q1[0] - q0[0]
  const dy = q1[1] - q0[1]
  const A = dx * dx + dy * dy
  if (A < 1e-18) return []
  const B = 2 * (q0[0] * dx + q0[1] * dy)
  const C = q0[0] * q0[0] + q0[1] * q0[1] - 1
  const disc = B * B - 4 * A * C
  if (disc < 0) return []
  const sd = Math.sqrt(disc)
  const pts: Vec2[] = []
  for (const sign of [-1, 1]) {
    const t = (-B + sign * sd) / (2 * A)
    if (t >= -1e-9 && t <= 1 + 1e-9) {
      pts.push([l.p0[0] + t * (l.p1[0] - l.p0[0]), l.p0[1] + t * (l.p1[1] - l.p0[1])])
    }
  }
  return pts
}

function circleCircle(
  a: Extract<Curve, { kind: "circle" }>,
  b: Extract<Curve, { kind: "circle" }>,
): Vec2[] {
  const dx = b.c[0] - a.c[0]
  const dy = b.c[1] - a.c[1]
  const d = Math.hypot(dx, dy)
  if (d < 1e-12 || d > a.r + b.r + 1e-12 || d < Math.abs(a.r - b.r) - 1e-12) return []
  const x = (a.r * a.r - b.r * b.r + d * d) / (2 * d)
  const h2 = a.r * a.r - x * x
  if (h2 < 0) return []
  const h = Math.sqrt(Math.max(0, h2))
  const mx = a.c[0] + (x * dx) / d
  const my = a.c[1] + (x * dy) / d
  const ox = (h * dy) / d
  const oy = (h * dx) / d
  if (h < 1e-12) return [[mx, my]]
  return [
    [mx + ox, my - oy],
    [mx - ox, my + oy],
  ]
}

/** Cubic Bezier vs line via the cubic the line's implicit form induces in t. */
function bezierLine(
  bz: Extract<Curve, { kind: "bezier" }>,
  l: Extract<Curve, { kind: "line" }>,
): number[] {
  // Signed distance to the (infinite) line is linear in (x, y), so substituting
  // the cubic gives a cubic in t. Scan it on [0, 1] (segment-clamp recovered by
  // the caller via the line param).
  const nx = l.p1[1] - l.p0[1]
  const ny = -(l.p1[0] - l.p0[0])
  const g = (t: number): number => {
    const p = bezierAt(bz, t)
    return nx * (p[0] - l.p0[0]) + ny * (p[1] - l.p0[1])
  }
  return scanRoots(g, 0, 1)
}

// ─── bezier vs bezier by recursive AABB subdivision ───

type BzCtrl = [Vec2, Vec2, Vec2, Vec2]

function bzSplit(c: BzCtrl, t: number): [BzCtrl, BzCtrl] {
  const lerp = (p: Vec2, q: Vec2): Vec2 => [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]
  const ab = lerp(c[0], c[1])
  const bc = lerp(c[1], c[2])
  const cd = lerp(c[2], c[3])
  const abc = lerp(ab, bc)
  const bcd = lerp(bc, cd)
  const abcd = lerp(abc, bcd)
  return [
    [c[0], ab, abc, abcd],
    [abcd, bcd, cd, c[3]],
  ]
}

function bbox(c: BzCtrl): [number, number, number, number] {
  const xs = [c[0][0], c[1][0], c[2][0], c[3][0]]
  const ys = [c[0][1], c[1][1], c[2][1], c[3][1]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function boxesOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1])
}

function bezierBezier(
  a: Extract<Curve, { kind: "bezier" }>,
  b: Extract<Curve, { kind: "bezier" }>,
): Hit[] {
  const ca: BzCtrl = [a.p0, a.c1, a.c2, a.p3]
  const cb: BzCtrl = [b.p0, b.c1, b.c2, b.p3]
  const out: Hit[] = []
  const FLAT = 1e-7
  const recurse = (
    x: BzCtrl,
    xt0: number,
    xt1: number,
    y: BzCtrl,
    yt0: number,
    yt1: number,
    depth: number,
  ): void => {
    const bx = bbox(x)
    const by = bbox(y)
    if (!boxesOverlap(bx, by)) return
    const sizeX = Math.max(bx[2] - bx[0], bx[3] - bx[1])
    const sizeY = Math.max(by[2] - by[0], by[3] - by[1])
    if ((sizeX < FLAT && sizeY < FLAT) || depth > 50) {
      out.push({
        point: [(x[0][0] + x[3][0]) / 2, (x[0][1] + x[3][1]) / 2],
        tA: 0.5 * (xt0 + xt1),
        tB: 0.5 * (yt0 + yt1),
      })
      return
    }
    const xm = 0.5 * (xt0 + xt1)
    const ym = 0.5 * (yt0 + yt1)
    const [x0, x1] = bzSplit(x, 0.5)
    const [y0, y1] = bzSplit(y, 0.5)
    recurse(x0, xt0, xm, y0, yt0, ym, depth + 1)
    recurse(x0, xt0, xm, y1, ym, yt1, depth + 1)
    recurse(x1, xm, xt1, y0, yt0, ym, depth + 1)
    recurse(x1, xm, xt1, y1, ym, yt1, depth + 1)
  }
  recurse(ca, 0, 1, cb, 0, 1, 0)
  return out
}

// ─── public entry point ───

/**
 * Intersection points of two curves with the parameter on each. Order of a and
 * b is preserved (tA refers to a, tB to b). Tangencies report no point.
 */
export function intersectCurves(a: Curve, b: Curve): Hit[] {
  const hits: Hit[] = []
  const push = (points: Vec2[]): void => {
    for (const p of points) hits.push({ point: p, tA: paramOf(a, p), tB: paramOf(b, p) })
  }

  // Scan a parametric curve, recover both params from the resulting points.
  const scanWith = (
    scanned: Curve,
    scannedIsA: boolean,
    residual: (p: Vec2) => number,
  ): void => {
    let params: number[]
    let evalAt: (t: number) => Vec2
    if (scanned.kind === "circle") {
      evalAt = (phi) => [scanned.c[0] + scanned.r * Math.cos(phi), scanned.c[1] + scanned.r * Math.sin(phi)]
      params = scanRoots((phi) => residual(evalAt(phi)), 0, TWO_PI)
    } else if (scanned.kind === "ellipse") {
      evalAt = (phi) => ellipseAt(scanned, phi)
      params = scanRoots((phi) => residual(evalAt(phi)), 0, TWO_PI)
    } else if (scanned.kind === "bezier") {
      const bz = scanned
      evalAt = (t) => bezierAt(bz, t)
      params = scanRoots((t) => residual(evalAt(t)), 0, 1)
    } else {
      throw new Error("scanWith: unsupported scanned curve kind")
    }
    for (const t of params) {
      const pt = evalAt(t)
      hits.push({
        point: pt,
        tA: scannedIsA ? t : paramOf(a, pt),
        tB: scannedIsA ? paramOf(b, pt) : t,
      })
    }
  }

  const k = `${a.kind}-${b.kind}`
  switch (k) {
    case "line-line":
      push(lineLine(a as never, b as never))
      break
    case "line-circle":
      push(lineCircle(a as never, b as never))
      break
    case "circle-line":
      push(lineCircle(b as never, a as never))
      break
    case "line-ellipse":
      push(lineEllipse(a as never, b as never))
      break
    case "ellipse-line":
      push(lineEllipse(b as never, a as never))
      break
    case "circle-circle":
      push(circleCircle(a as never, b as never))
      break
    case "circle-ellipse":
      scanWith(b, false, conicResidual(a))  // scan the ellipse, circle residual
      break
    case "ellipse-circle":
      scanWith(a, true, conicResidual(b))
      break
    case "ellipse-ellipse":
      scanWith(a, true, conicResidual(b))
      break
    case "bezier-line": {
      const ts = bezierLine(a as never, b as never)
      for (const t of ts) {
        const p = bezierAt(a as never, t)
        const lp = paramOf(b, p)
        if (lp < -1e-9 || lp > 1 + 1e-9) continue  // crossing the infinite line, not the segment
        hits.push({ point: p, tA: t, tB: lp })
      }
      break
    }
    case "line-bezier": {
      const ts = bezierLine(b as never, a as never)
      for (const t of ts) {
        const p = bezierAt(b as never, t)
        const lp = paramOf(a, p)
        if (lp < -1e-9 || lp > 1 + 1e-9) continue
        hits.push({ point: p, tA: lp, tB: t })
      }
      break
    }
    case "bezier-circle":
    case "bezier-ellipse":
      scanWith(a, true, conicResidual(b))
      break
    case "circle-bezier":
    case "ellipse-bezier":
      scanWith(b, false, conicResidual(a))
      break
    case "bezier-bezier":
      hits.push(...bezierBezier(a as never, b as never))
      break
    default:
      break
  }

  // A clean pair crosses in few points (conic-conic <=4, conic-Bezier <=6,
  // Bezier-Bezier <=9). A blow-up past that means the two carriers are
  // (near-)coincident -- a degenerate overlap, not a transversal crossing -- so
  // report nothing rather than a ring of phantom split points.
  const out = dedupHits(hits)
  return out.length > 10 ? [] : out
}
