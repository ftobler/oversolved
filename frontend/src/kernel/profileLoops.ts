// Arc sampling, polygon point list, area-weighted centroid. Only what the slice
// topology needs lives here.

import { TOL_NEAR_ZERO_AREA } from "./solverConstants"

const CENTROID_ARC_SAMPLES = 64

export type LoopEdge = Record<string, unknown>

export function radians(deg: number): number {
  return (deg * Math.PI) / 180
}

/** n interior points spread along an arc edge (n>=1); empty if not an arc. */
export function arcSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e["kind"] !== "arc") return []
  const center = e["center"] as number[] | undefined
  if (center === undefined || center === null) return []
  const cx = center[0]
  const cy = center[1]
  const r = (e["radius"] as number) ?? 0.0
  let a0 = radians((e["angle_start_deg"] as number) ?? 0.0)
  let a1 = radians((e["angle_end_deg"] as number) ?? 0.0)
  if (!((e["ccw"] as boolean) ?? true)) {
    const tmp = a0
    a0 = a1
    a1 = tmp
  }
  if (a1 < a0) a1 += 2 * Math.PI
  const out: number[][] = []
  for (let k = 0; k < n; k++) {
    const a = a0 + ((a1 - a0) * (k + 1)) / (n + 1)
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return out
}

/** n interior points sampled along a cubic-Bezier spline edge; empty if not one. */
export function splineSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e["kind"] !== "spline") return []
  const p1 = e["start"] as number[]
  const c1 = e["c1"] as number[]
  const c2 = e["c2"] as number[]
  const p4 = e["end"] as number[]
  if (!p1 || !c1 || !c2 || !p4) return []
  const out: number[][] = []
  for (let k = 0; k < n; k++) {
    const t = (k + 1) / (n + 1)
    const mt = 1 - t
    const a = mt * mt * mt
    const b = 3 * mt * mt * t
    const c = 3 * mt * t * t
    const d = t * t * t
    out.push([
      a * p1[0] + b * c1[0] + c * c2[0] + d * p4[0],
      a * p1[1] + b * c1[1] + c * c2[1] + d * p4[1],
    ])
  }
  return out
}

/** True for a spline edge whose start and end coincide (a closed self-loop). */
function splineIsClosed(e: LoopEdge): boolean {
  if (e["kind"] !== "spline") return false
  const p1 = e["start"] as number[] | undefined
  const p4 = e["end"] as number[] | undefined
  if (!p1 || !p4) return false
  return Math.hypot(p1[0] - p4[0], p1[1] - p4[1]) < 1e-6
}

/** n interior points along an elliptical-arc edge; empty if not one. */
export function ellipseArcSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e["kind"] !== "ellipse_arc") return []
  const center = e["center"] as number[] | undefined
  if (!center) return []
  const a = (e["a"] as number) ?? 0.0
  const b = (e["b"] as number) ?? 0.0
  const rot = radians((e["theta"] as number) ?? 0.0)
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const p0 = radians((e["angle_start_deg"] as number) ?? 0.0)
  let p1 = radians((e["angle_end_deg"] as number) ?? 0.0)
  const ccw = (e["ccw"] as boolean) ?? true
  if (ccw) { if (p1 < p0) p1 += 2 * Math.PI } else if (p1 > p0) p1 -= 2 * Math.PI
  const out: number[][] = []
  for (let k = 0; k < n; k++) {
    const phi = p0 + ((p1 - p0) * (k + 1)) / (n + 1)
    const ax = a * Math.cos(phi)
    const ay = b * Math.sin(phi)
    out.push([center[0] + ax * cr - ay * sr, center[1] + ax * sr + ay * cr])
  }
  return out
}

/** n points spread around a full closed ellipse edge; empty if not one. */
export function ellipseSamplePoints(e: LoopEdge, n: number): number[][] {
  if (e["kind"] !== "ellipse") return []
  const center = e["center"] as number[] | undefined
  if (center === undefined || center === null) return []
  const cx = center[0]
  const cy = center[1]
  const a = (e["a"] as number) ?? 0.0
  const b = (e["b"] as number) ?? 0.0
  const rot = radians((e["theta"] as number) ?? 0.0)
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const out: number[][] = []
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n
    const ax = a * Math.cos(t)
    const ay = b * Math.sin(t)
    out.push([cx + ax * cr - ay * sr, cy + ax * sr + ay * cr])
  }
  return out
}

/** Polygon point list from a loop, inserting arc/spline/ellipse sample points. */
export function loopPts(loop: LoopEdge[], arcSamples = 1): number[][] {
  const pts: number[][] = []
  for (const e of loop) {
    if ("start" in e) pts.push(e["start"] as number[])
    pts.push(...arcSamplePoints(e, arcSamples))
    pts.push(...ellipseArcSamplePoints(e, Math.max(arcSamples, 4)))
    // A self-closing spline (start == end) is a standalone closed loop, so it
    // needs enough points to read as a polygon on its own, like a full ellipse.
    pts.push(...splineSamplePoints(e, splineIsClosed(e) ? Math.max(arcSamples * 4, 16) : arcSamples))
    // A full ellipse is a standalone closed loop: it needs enough points to read
    // as a polygon on its own, independent of the coarse arc sample count.
    pts.push(...ellipseSamplePoints(e, Math.max(arcSamples * 4, 16)))
  }
  return pts
}

/** Signed 2D area via the shoelace formula. Positive = CCW. */
export function loopSignedArea(loop: LoopEdge[]): number {
  const pts = loopPts(loop)
  const n = pts.length
  if (n < 3) return 0.0
  let acc = 0.0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    acc += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
  }
  return acc / 2.0
}

/** Ray-casting point-in-polygon test against a 2D loop. */
export function pointInLoop(pt: number[], loop: LoopEdge[]): boolean {
  const x = pt[0]
  const y = pt[1]
  const pts = loopPts(loop)
  const n = pts.length
  let inside = false
  let j = n - 1
  for (let i = 0; i < n; i++) {
    const xi = pts[i][0]
    const yi = pts[i][1]
    const xj = pts[j][0]
    const yj = pts[j][1]
    if (yi > y !== yj > y) {
      if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    j = i
  }
  return inside
}

/**
 * Containment analysis: for each loop, its nesting `depth` (how many other
 * loops enclose it) and its immediate `container` (the smallest strictly larger
 * loop that encloses it, or -1 if none).
 */
function loopContainment(loops: LoopEdge[][]): { depth: number[]; container: number[] } {
  const n = loops.length
  const areas = loops.map((loop) => Math.abs(loopSignedArea(loop)))
  const cents = loops.map((loop) => loopCentroid(loop))

  const depth: number[] = new Array(n).fill(0)
  const container: number[] = new Array(n).fill(-1)  // immediate enclosing loop
  for (let i = 0; i < n; i++) {
    let bestArea = Infinity
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      if (areas[j] > areas[i] && pointInLoop(cents[i], loops[j])) {
        depth[i] += 1
        if (areas[j] < bestArea) {
          bestArea = areas[j]
          container[i] = j
        }
      }
    }
  }
  return { depth, container }
}

/**
 * Group loops into (outer, holes) pairs for face construction by even/odd
 * containment depth: a loop enclosed by an even number of others is a filled
 * face, one enclosed by an odd number is a hole of its immediate (smallest
 * strictly larger) container. A solid island inside a hole (depth 2) is its own
 * face again -- so arbitrary nesting works, not just one level. This is the
 * extrude/solid model where two concentric circles fuse into one washer solid.
 */
export function classifyLoops(loops: LoopEdge[][]): [LoopEdge[], LoopEdge[][]][] {
  if (loops.length === 0) return []
  if (loops.length === 1) return [[loops[0], []]]

  const n = loops.length
  const { depth, container } = loopContainment(loops)

  const result: [LoopEdge[], LoopEdge[][]][] = []
  for (let oi = 0; oi < n; oi++) {
    if (depth[oi] % 2 === 1) continue  // a hole, attached to its container below
    const holes: LoopEdge[][] = []
    for (let i = 0; i < n; i++) if (depth[i] % 2 === 1 && container[i] === oi) holes.push(loops[i])
    result.push([loops[oi], holes])
  }
  return result
}

/**
 * Planar subdivision: every loop bounds its own face whose holes are the loops
 * immediately nested inside it -- at every depth, not just even ones. Two
 * concentric circles yield two areas: the outer ring (with the inner circle as
 * a hole) AND the inner disk. This is the sketch-area model, where every region
 * the eye can see is selectable, unlike the even/odd `classifyLoops` donut.
 */
export function subdivideLoops(loops: LoopEdge[][]): [LoopEdge[], LoopEdge[][]][] {
  if (loops.length === 0) return []
  if (loops.length === 1) return [[loops[0], []]]

  const n = loops.length
  const { container } = loopContainment(loops)

  const result: [LoopEdge[], LoopEdge[][]][] = []
  for (let oi = 0; oi < n; oi++) {
    const holes: LoopEdge[][] = []
    for (let i = 0; i < n; i++) if (container[i] === oi) holes.push(loops[i])
    result.push([loops[oi], holes])
  }
  return result
}

/** Area-weighted centroid of a 2D loop polygon. */
export function loopCentroid(loop: LoopEdge[]): number[] {
  const pts = loopPts(loop, CENTROID_ARC_SAMPLES)
  const n = pts.length
  if (n < 3) return [0.0, 0.0]
  let cx = 0.0
  let cy = 0.0
  let area = 0.0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const cross = pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    area += cross
    cx += (pts[i][0] + pts[j][0]) * cross
    cy += (pts[i][1] + pts[j][1]) * cross
  }
  area /= 2.0
  if (Math.abs(area) < TOL_NEAR_ZERO_AREA) return [pts[0][0], pts[0][1]]
  cx /= 6.0 * area
  cy /= 6.0 * area
  return [cx, cy]
}
