// Port of the profile-loop helpers oversolved/kernel/profile_loops.py exposes
// to topology.ts: arc sampling, polygon point list, area-weighted centroid.
// Only the slice topology needs is ported here.

import { TOL_NEAR_ZERO_AREA } from "./solverConstants"

const CENTROID_ARC_SAMPLES = 64

export type LoopEdge = Record<string, unknown>

function radians(deg: number): number {
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
    pts.push(...splineSamplePoints(e, arcSamples))
    // A full ellipse is a standalone closed loop: it needs enough points to read
    // as a polygon on its own, independent of the coarse arc sample count.
    pts.push(...ellipseSamplePoints(e, Math.max(arcSamples * 4, 16)))
  }
  return pts
}

/** Signed 2D area via the shoelace formula. Positive = CCW (mirrors `_loop_signed_area`). */
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

/** Ray-casting point-in-polygon test against a 2D loop (mirrors `_point_in_loop`). */
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
 * Group loops into (outer, holes) pairs for face construction (mirrors
 * `classify_loops`). Loops contained inside another loop become holes of the
 * smallest enclosing outer loop; uncontained loops are independent outer
 * boundaries (disjoint closed areas, each its own face).
 */
export function classifyLoops(loops: LoopEdge[][]): [LoopEdge[], LoopEdge[][]][] {
  if (loops.length === 0) return []
  if (loops.length === 1) return [[loops[0], []]]

  const n = loops.length
  const areas = loops.map((loop) => Math.abs(loopSignedArea(loop)))

  // For each loop, find the smallest STRICTLY larger loop that contains it.
  const containedBy: number[] = new Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const pt = loopCentroid(loops[i])
    let best = -1
    let bestArea = Infinity
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      if (areas[j] > areas[i] && areas[j] < bestArea && pointInLoop(pt, loops[j])) {
        best = j
        bestArea = areas[j]
      }
    }
    containedBy[i] = best
  }

  const result: [LoopEdge[], LoopEdge[][]][] = []
  for (let oi = 0; oi < n; oi++) {
    if (containedBy[oi] !== -1) continue
    const holes: LoopEdge[][] = []
    for (let i = 0; i < n; i++) if (containedBy[i] === oi) holes.push(loops[i])
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
