// A profile pick that landed on a sketch CURVE instead of on the area fill.
// The viewport toggles those into the chip as `entity:<sketch>:<eid>`
// (picking/useSketchIdRegistration.ts), so extrude/revolve/sweep see the raw
// selection id and have to answer with the area that one curve bounds -- or
// refuse. Before this path existed the ref fell through to the `$sketch`
// branch, which read `_pt_entity:sk1:ci` and threw "sketch not found".
//
// The topology fixtures are the real area-builder output (occ/__fixtures__/
// topology.json, replayed by kernel/topology.test.ts), so the cases here are the
// shapes the Rust builder actually emits: an undivided circle that owns its
// area, and a circle something crosses that survives only as split edges.

import { describe, it, expect } from 'vitest'
import { Repository, makeAncestryQuery } from '../query'
import { collectExtrudeLoops } from './faceProfile'
import { loopSignedArea, CENTROID_ARC_SAMPLES } from '../profileLoops'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'
import fixtures from '../occ/__fixtures__/topology.json'

type Dict = Record<string, unknown>
type Case = { feature_id: string; expected: { edges: Dict[]; surfaces: Dict[] } }

const FIXTURES = fixtures as unknown as Record<string, Case>

const PLANE = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

// The entity path never touches OCC: no shape is read and no face is returned.
const oc = null as unknown as OccModule
const table = null as unknown as HandleTable
const bodyStore: Record<string, Body> = {}

function repoFor(name: string): { repo: Repository; sketchId: string } {
  const fx = FIXTURES[name]
  const repo = new Repository()
  repo.register('_pt_' + fx.feature_id, { ...PLANE })
  repo.register('_topo_' + fx.feature_id, {
    edges: fx.expected.edges.map((e) => ({ ...e })),
    surfaces: fx.expected.surfaces.map((s) => ({ ...s })),
  })
  return { repo, sketchId: fx.feature_id }
}

function resolve(name: string, ref: string) {
  const { repo } = repoFor(name)
  return collectExtrudeLoops(oc, null as never, table, ref, 'ex1', 5, repo, bodyStore)
}

/**
 * Assert the single resolved loop is the disc of radius `r`. The measured area
 * is the CENTROID_ARC_SAMPLES-gon inscribed in the circle, which sits ~0.06%
 * under the true area, so the comparison is relative -- tight enough that a
 * half disc or a lens could never pass it.
 */
function expectDisc(loops: Dict[][], r: number): void {
  expect(loops.length).toBe(1)
  const area = Math.abs(loopSignedArea(loops[0], CENTROID_ARC_SAMPLES))
  expect(area / (Math.PI * r * r)).toBeCloseTo(1, 2)
}

describe('profile pick of a sketch entity', () => {
  it('resolves an undivided circle to the area it owns', () => {
    const { loops, plane, sketchId, face } = resolve('standalone_circle', 'entity:skC:ci')
    expect(sketchId).toBe('skC')
    expect(face).toBeNull()
    expect(plane.normal).toEqual([0, 0, 1])
    expectDisc(loops, 5)
  })

  it('resolves a circle a line crosses to the WHOLE disc, not one half', () => {
    // The two regions the sketch shows are half discs; the pick is the circle,
    // so its own two arcs chain back into the full disc.
    const { loops } = resolve('line_through_circle', 'entity:skLC:ci')
    expectDisc(loops, 5)
    for (const e of loops[0]) {
      expect(e.kind).toBe('arc')
      expect(e.radius).toBe(5)
    }
  })

  it('keeps a pick of one circle out of its neighbour', () => {
    // Two r=6 circles centred 8 apart: the left one is cut into two crescent
    // arcs, and its disc is the answer -- no part of the right circle.
    const { loops } = resolve('two_circles_intersecting', 'entity:skX:ci_l')
    expectDisc(loops, 6)
    for (const e of loops[0]) expect((e.center as number[])[0]).toBeCloseTo(0, 6)
  })

  // A washer: an undivided r=4 circle with a concentric r=1.5 circle inside it.
  // The area builder gives the outer circle its own area carrying the inner
  // loop as a `holes` entry, and the inner circle its own area next to it.
  // `divided` adds the split edges a chord through the outer circle would leave
  // behind, and drops the outer circle's own area the way `build_standalone`
  // does once something cuts the curve.
  function washerTopo(divided: boolean) {
    const arcs = (r: number, id: string) => [
      { kind: 'arc', center: [0, 0], radius: r, angle_start_deg: 0, angle_end_deg: 180,
        ccw: true, start: [r, 0], end: [-r, 0], id },
      { kind: 'arc', center: [0, 0], radius: r, angle_start_deg: 180, angle_end_deg: 360,
        ccw: true, start: [-r, 0], end: [r, 0], id },
    ]
    const areaQuery = (eid: string, idx: number) =>
      makeAncestryQuery([`@skW/${eid}`, `surface:${idx}`, '@skW'], 'flatface')
    const inner = { boundary: arcs(1.5, 'ci'), query: areaQuery('ci', 1) }
    const outer = { boundary: arcs(4, 'co'), holes: [arcs(1.5, 'ci')], query: areaQuery('co', 0) }
    return {
      edges: divided ? arcs(4, 'co').map((e, i) => ({ ...e, entity_id: 'co', edge_index: i })) : [],
      surfaces: divided ? [inner] : [outer, inner],
    }
  }

  function washerLoops(divided: boolean) {
    const repo = new Repository()
    repo.register('_pt_skW', { ...PLANE })
    repo.register('_topo_skW', washerTopo(divided))
    return collectExtrudeLoops(oc, null as never, table, 'entity:skW:co', 'ex1', 5, repo, bodyStore).loops
  }

  it('extrudes what the picked circle encloses, hole included', () => {
    // The inner circle bounds its own filled area, so the fill inside the pick
    // is solid: subtracting it would answer with a ring the user cannot see.
    expectDisc(washerLoops(false), 4)
  })

  it('answers the same whether or not something divided the picked circle', () => {
    // The two branches must not disagree: a chord through the outer circle
    // takes away its own area and leaves only its split edges behind.
    expectDisc(washerLoops(true), 4)
  })

  it('reads a vertex pick as the entity that owns the vertex', () => {
    const viaVertex = resolve('standalone_circle', 'vertex:skC:ci:center')
    expect(viaVertex.loops).toEqual(resolve('standalone_circle', 'entity:skC:ci').loops)
  })

  it('refuses a line that borders an area but closes nothing', () => {
    // The square's bottom edge bounds the square region, but the user picked a
    // line: answering with the square would extrude geometry they did not pick.
    expect(() => resolve('square', 'entity:sk1:ln_b')).toThrow(/bounds no closed area/)
  })

  it('refuses an open chain of collinear pieces', () => {
    expect(() => resolve('line_through_circle', 'entity:skLC:ln')).toThrow(/bounds no closed area/)
  })

  it('refuses an entity the sketch does not have', () => {
    expect(() => resolve('standalone_circle', 'entity:skC:nope')).toThrow(/bounds no closed area/)
  })

  it('reports the missing sketch, not a missing entity', () => {
    const { repo } = repoFor('standalone_circle')
    expect(() => collectExtrudeLoops(oc, null as never, table, 'entity:gone:ci', 'ex1', 5, repo, bodyStore))
      .toThrow(/sketch not found: gone/)
  })
})
