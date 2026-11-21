// @vitest-environment node
//
// Point-touching profile regions: each edge-connected cluster is built on the
// existing single/merged/per-group path and the clusters are compounded without
// a boolean. Two externally tangent circles therefore extrude to two cylinders
// whose only line edge is each cylinder's own seam, with no edge along the
// contact. Also pins the internal-tangent control, the combined sketch that used
// to fail on a duplicated cap identity, and the taper decision (each cluster
// drafts alone, as it did before the cluster split for disjoint groups).
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { canonicalFaces } from '../../occ/partNames'
import { faceSurfaceType } from '../../occ/primitives'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

const DEPTH = 10

interface EdgeRow { kind?: string }
interface PartRender {
  edges?: EdgeRow[]
  edge_queries?: string[]
  mesh?: { face_seam_queries?: string[][] }
}

/** Circles `[cx, cy, r]`, every entity fixed so the authored tangencies hold. */
function circlesSpec(circles: number[][], extrude: Record<string, unknown> = {}) {
  const entities = circles.map((_, i) => ({ id: `c${i}`, kind: 'circle' }))
  const initial = Object.fromEntries(circles.map((c, i) => [`c${i}`, c]))
  return {
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities, initial,
        constraints: entities.map((e, i) => ({ id: `f${i}`, kind: 'fixed', target: { entity: e.id } })),
      },
      {
        id: 'ex1', kind: 'extrude', label: 'Extrude',
        extrude: { sketch: '@sk1', distance: DEPTH, direction: 'normal', operation: 'new', ...extrude },
      },
    ],
  }
}

function frustumVolume(rBase: number, rTop: number, height: number): number {
  return (Math.PI * height / 3) * (rBase * rBase + rBase * rTop + rTop * rTop)
}

/** The area two circles share: the two circular segments their common chord cuts. */
function circleLens(r1: number, r2: number, d: number): number {
  const a = (d * d - r2 * r2 + r1 * r1) / (2 * d)
  const b = (d * d + r2 * r2 - r1 * r1) / (2 * d)
  const segment = (r: number, x: number): number => {
    const ratio = Math.min(1, Math.max(-1, x / r))
    return r * r * Math.acos(ratio) - x * Math.sqrt(Math.max(r * r - x * x, 0))
  }
  return segment(r1, a) + segment(r2, b)
}

describe.skipIf(!oc || !solveBytes)('point-touching profile regions (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  function partIds(result: BuildResponse): string[] {
    const store = result._build_state!.checkpoints['ex1'].body_store_snapshot
    return Object.keys(store).filter((id) => id === 'body_ex1' || id.startsWith('body_ex1_'))
  }

  function shapeOf(result: BuildResponse, partId: string): OccShape {
    return h.table.get<OccShape>(result._build_state!.checkpoints['ex1'].body_store_snapshot[partId].shape!)
  }

  function gauges(result: BuildResponse, partId: string) {
    const scope = new DisposeScope()
    try {
      const shape = shapeOf(result, partId)
      const faces = canonicalFaces(oc!, scope, shape)
      return {
        volume: volumeOf(oc!, scope, shape),
        cylinders: faces.filter((f) => faceSurfaceType(oc!, scope, f) === 'cylinderface').length,
        planes: faces.filter((f) => faceSurfaceType(oc!, scope, f) === 'flatface').length,
      }
    } finally {
      scope.dispose()
    }
  }

  // The construction queries of the body's line edges, in render order.
  function lineEdgeQueries(result: BuildResponse, partId: string): string[] {
    const part = h.part(result, partId) as PartRender
    const rows = part.edges ?? []
    return rows.flatMap((row, i) => (row.kind === 'line' ? [part.edge_queries?.[i] ?? ''] : []))
  }

  // Every query a face names as its own seam.
  function seamQueries(result: BuildResponse, partId: string): string[] {
    const part = h.part(result, partId) as PartRender
    return (part.mesh?.face_seam_queries ?? []).flat()
  }

  it('extrudes externally tangent circles as two unsplit cylinders', () => {
    const result = h.run(circlesSpec([[0, 0, 10], [0, 15, 5]]))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(partIds(result)).toEqual(['body_ex1', 'body_ex1_1'])

    // Cluster order is profile order and the split numbers geometrically, so
    // the lower circle keeps the base body id for this fixture.
    const big = gauges(result, 'body_ex1')
    const small = gauges(result, 'body_ex1_1')
    expect(big.volume).toBeCloseTo(Math.PI * 100 * DEPTH, 6)
    expect(small.volume).toBeCloseTo(Math.PI * 25 * DEPTH, 6)
    for (const partId of ['body_ex1', 'body_ex1_1']) {
      const g = gauges(result, partId)
      // One lateral cylinder and two caps: the wall was never split at the
      // contact, so the body has no edge at the tangent point.
      expect(g.cylinders, partId).toBe(1)
      expect(g.planes, partId).toBe(2)
      const lines = lineEdgeQueries(result, partId)
      expect(lines, partId).toHaveLength(1)
      const seams = seamQueries(result, partId)
      expect(seams, partId).toContain(lines[0])
    }
  })

  it('keeps an internally tangent circle as one body with a hole', () => {
    // The r5 disc is inside the r10 and touches it: one group with a hole, no
    // cluster boundary at all, exactly as before the cluster split.
    const result = h.run(circlesSpec([[0, 0, 10], [5, 0, 5]]))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(partIds(result)).toEqual(['body_ex1'])
    const g = gauges(result, 'body_ex1')
    expect(g.volume).toBeCloseTo(Math.PI * 75 * DEPTH, 6)
    expect(g.cylinders).toBe(2)  // the outer wall and the bore
  })

  it('builds the tangent trio beside an overlapping pair as four parts', () => {
    // The report that failed with "two fused profile regions minted the same
    // cap identity": three tangent circles (three single-group clusters) and a
    // pair of overlapping circles (one merged cluster) in one sketch.
    const result = h.run(circlesSpec([
      [40, 0, 10], [40, 15, 5], [55, 0, 5],
      [80, 0, 10], [80, 8, 6],
    ]))
    const ex = h.res(result, 'ex1')
    expect(ex.status).toBe('ok')
    expect(ex.exception).toBeUndefined()
    const ids = partIds(result)
    expect(ids).toHaveLength(4)
    const union = Math.PI * (100 + 36) - circleLens(10, 6, 8)
    const expected = (Math.PI * 100 + Math.PI * 25 + Math.PI * 25 + union) * DEPTH
    const total = ids.reduce((sum, id) => sum + gauges(result, id).volume, 0)
    expect(total).toBeCloseTo(expected, 5)
  })

  it('drafts each tangent circle alone, as two conical parts', () => {
    // The taper decision: a cluster of one group has nothing to fuse, so a
    // draft is allowed exactly as it was for disconnected multi-group profiles.
    const result = h.run(circlesSpec([[0, 0, 10], [0, 15, 5]], { taper: 10 }))
    expect(h.res(result, 'ex1').status).toBe('ok')
    const ids = partIds(result)
    expect(ids).toEqual(['body_ex1', 'body_ex1_1'])
    const rTop = (r: number): number => r - DEPTH * Math.tan((10 * Math.PI) / 180)
    // The drafted cones' seam vertices move the geometric split order, so the
    // ids are not pinned here; the multiset of volumes is what the taper
    // decision asserts.
    const volumes = ids.map((id) => gauges(result, id).volume).sort((a, b) => a - b)
    expect(volumes[0]).toBeCloseTo(frustumVolume(5, rTop(5), DEPTH), 5)
    expect(volumes[1]).toBeCloseTo(frustumVolume(10, rTop(10), DEPTH), 5)
  })
})
