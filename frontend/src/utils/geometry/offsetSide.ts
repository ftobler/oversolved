// PURE -- no doc mutation. Which way a sketch offset goes for each selected
// entity, so a positive distance means one side of a closed loop whatever the
// loop's winding or provenance.
//
// The seed rule alone (offsetSeed: a line moves along the left normal of its
// start->end direction, a circle or arc grows its radius) is winding-dependent:
// +2 went inward on a CCW triangle (birdhouse F3) and outward on a projected rim
// whose edges ran the other way (Case_Seam_Lip F6). When the selection closes
// into loops, each entity's seed sign is corrected so a positive distance moves
// it OUT of the region the loops bound (even-odd, so a selected inner loop is a
// hole and its positive offset shrinks the hole), matching OpenSCAD's
// `offset(r>0)` and CadQuery's positive `offset2D`. An open selection keeps the
// plain seed rule: it bounds no region, so "outward" has no meaning there.

import { endpointVertices } from './offsetProfile'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'

type Point = [number, number]
type Segment = [Point, Point]

export interface OffsetSource {
  id: string
  kind: string
  params: readonly number[]
}

// Arcs and circles are polygonized for the inside test. An even count puts a
// vertex on the arc's mid angle, the point the side probe starts from, so the
// probe sits on the true curve rather than on a chord.
const ARC_PIECES = 64

function arcSweepDeg(a0: number, a1: number): number {
  const sweep = (((a1 - a0) % 360) + 360) % 360
  return sweep === 0 ? 360 : sweep
}

function arcPoint(cx: number, cy: number, r: number, deg: number): Point {
  const t = (deg * Math.PI) / 180
  return [cx + r * Math.cos(t), cy + r * Math.sin(t)]
}

function segmentsOf(source: OffsetSource): Segment[] {
  const p = source.params
  if (source.kind === 'line') return [[[p[0], p[1]], [p[2], p[3]]]]
  if (source.kind === 'circle' || source.kind === 'arc') {
    const [cx, cy, r] = p
    const a0 = source.kind === 'arc' ? p[3] : 0
    const sweep = source.kind === 'arc' ? arcSweepDeg(p[3], p[4]) : 360
    const out: Segment[] = []
    for (let i = 0; i < ARC_PIECES; i++) {
      out.push([
        arcPoint(cx, cy, r, a0 + (sweep * i) / ARC_PIECES),
        arcPoint(cx, cy, r, a0 + (sweep * (i + 1)) / ARC_PIECES),
      ])
    }
    return out
  }
  return []
}

/** Even-odd inside test against an unordered segment soup (a +x ray). */
function inside(point: Point, segments: readonly Segment[]): boolean {
  let crossings = 0
  for (const [a, b] of segments) {
    // Half-open in y, so a ray through a shared vertex counts it once.
    if ((a[1] > point[1]) === (b[1] > point[1])) continue
    const x = a[0] + ((point[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])
    if (x > point[0]) crossings++
  }
  return crossings % 2 === 1
}

/** Every line/arc endpoint meets an endpoint of another selected entity. */
function closesIntoLoops(sources: readonly OffsetSource[]): boolean {
  const vertices: Array<{ id: string; point: Point }> = []
  for (const s of sources) {
    if (s.kind !== 'line' && s.kind !== 'arc') continue
    for (const v of endpointVertices(s.kind, s.params)) vertices.push({ id: s.id, point: v.point })
  }
  return vertices.every((v, i) => vertices.some((w, j) =>
    j !== i && w.id !== v.id
      && Math.hypot(w.point[0] - v.point[0], w.point[1] - v.point[1]) <= TOL_TOPOLOGY_MERGE))
}

/**
 * The factor each source's seed distance takes: -1 where the seed rule's
 * positive side points into the bounded region, +1 elsewhere. Empty for an
 * open selection, a selection with a spline or ellipse (no seed side), or one
 * with nothing that bounds a region; the caller then applies the seed rule.
 */
export function offsetSideFactors(sources: readonly OffsetSource[]): Map<string, number> {
  const factors = new Map<string, number>()
  const supported = sources.filter((s) => s.kind === 'line' || s.kind === 'arc' || s.kind === 'circle')
  if (supported.length !== sources.length || supported.length === 0) return factors
  if (!closesIntoLoops(supported)) return factors
  const segments = supported.flatMap(segmentsOf)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [a, b] of segments) {
    for (const q of [a, b]) {
      minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0])
      minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1])
    }
  }
  const eps = 1e-6 * Math.max(1, Math.hypot(maxX - minX, maxY - minY))
  for (const s of supported) {
    const p = s.params
    let from: Point
    let toward: Point  // the seed rule's positive direction at `from`, unit
    if (s.kind === 'line') {
      const dx = p[2] - p[0], dy = p[3] - p[1]
      const len = Math.hypot(dx, dy)
      if (len < 1e-9) continue
      from = [(p[0] + p[2]) / 2, (p[1] + p[3]) / 2]
      toward = [-dy / len, dx / len]
    } else {
      const mid = s.kind === 'arc' ? p[3] + arcSweepDeg(p[3], p[4]) / 2 : 0
      from = arcPoint(p[0], p[1], p[2], mid)
      const t = (mid * Math.PI) / 180
      toward = [Math.cos(t), Math.sin(t)]
    }
    const probe: Point = [from[0] + eps * toward[0], from[1] + eps * toward[1]]
    factors.set(s.id, inside(probe, segments) ? -1 : 1)
  }
  return factors
}
