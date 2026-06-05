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

/** Polygon point list from a loop, inserting arc sample points. */
export function loopPts(loop: LoopEdge[], arcSamples = 1): number[][] {
  const pts: number[][] = []
  for (const e of loop) {
    if ("start" in e) pts.push(e["start"] as number[])
    pts.push(...arcSamplePoints(e, arcSamples))
  }
  return pts
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
