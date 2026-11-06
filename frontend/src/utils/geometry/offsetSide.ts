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
import { inside, probeExtent, segmentsOf, type ProfileSource } from './profileProbe'
import { TOL_TOPOLOGY_MERGE } from '@/kernel/solverConstants'

type Point = [number, number]

// The offset rule's sources are the shared profile probe's sources. The alias
// keeps this module's callers unchanged while the even-odd soup lives in one
// place.
export type OffsetSource = ProfileSource

// Arcs and circles are polygonized for the inside test by the shared probe; an
// even count puts a vertex on the arc's mid angle, the point the side probe
// starts from, so the probe sits on the true curve rather than on a chord.
function arcSweepDeg(a0: number, a1: number): number {
  const sweep = (((a1 - a0) % 360) + 360) % 360
  return sweep === 0 ? 360 : sweep
}

function arcPoint(cx: number, cy: number, r: number, deg: number): Point {
  const t = (deg * Math.PI) / 180
  return [cx + r * Math.cos(t), cy + r * Math.sin(t)]
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
  // The supported filter above keeps every kind the probe samples, so a null
  // block here is unreachable; dropping it keeps the soup type non-nullable.
  const segments = supported.flatMap(s => segmentsOf(s) ?? [])
  const eps = 1e-6 * probeExtent(segments)
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
