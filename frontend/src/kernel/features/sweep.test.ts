// Always-on tests for the sweep leaf's OCC-free logic (phase 2f): the path-chain
// ordering, path-ref resolution, and solveSweep guard paths. The geometry-
// producing path is gated in occ/sweepReal.test.ts.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Repository } from '../query'
import { solveSweep, orderEdgesIntoChain, pathRefToSketchId, orderedPathWorldEdges, type ChainEdge } from './sweep'
import { collectExtrudeLoops } from './faceProfile'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { Body } from '../types3d'

// The mixed-profile refusal needs a profile that resolves to a body face, which
// the OCC-free harness cannot produce (a face only ever comes out of an OCC face
// read). Drive collectExtrudeLoops with a call-through double so the pre-existing
// tests keep the real $sketch path, and override it per-test to hand solveSweep
// a face+loops profile.
vi.mock('./faceProfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./faceProfile')>()
  return { ...actual, collectExtrudeLoops: vi.fn(actual.collectExtrudeLoops) }
})

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable

type Edge = Record<string, unknown>

afterEach(() => {
  vi.mocked(collectExtrudeLoops).mockRestore()
})

describe('orderEdgesIntoChain', () => {
  it('orders a shuffled chain so consecutive edges connect', () => {
    const edges: Edge[] = [
      { id: 'b', start: [1, 0], end: [2, 0] },
      { id: 'c', start: [2, 0], end: [3, 0] },
      { id: 'a', start: [0, 0], end: [1, 0] },
    ]
    const ordered = orderEdgesIntoChain(edges)
    // Direction is not fixed (either degree-1 end may start the walk), so assert
    // the sequence is a valid connected chain a-b-c (forward or reversed).
    const ids = ordered.map((ce) => ce.edge.id).join('')
    expect(['abc', 'cba']).toContain(ids)
  })

  it('returns a single edge unchanged', () => {
    const edges: Edge[] = [{ id: 'only', start: [0, 0], end: [1, 1] }]
    const result = orderEdgesIntoChain(edges)
    expect(result).toHaveLength(1)
    expect(result[0].edge).toEqual(edges[0])
    expect(result[0].reversed).toBe(false)
  })

  it('throws when edges do not form a connected chain', () => {
    const edges: Edge[] = [
      { id: 'a', start: [0, 0], end: [1, 0] },
      { id: 'b', start: [5, 5], end: [6, 5] },
    ]
    expect(() => orderEdgesIntoChain(edges)).toThrow(/connected chain/)
  })

  it('orders 3D world edges, distinguishing endpoints that share x/y', () => {
    // Two edges meeting at (10,0,0); edge c rises in z so both its endpoints
    // share the same x/y. A 2D-only comparison would mis-degree it.
    const edges: Edge[] = [
      { id: 'c', start: [10, 0, 0], end: [10, 0, 5] },
      { id: 'l', start: [0, 0, 0], end: [10, 0, 0] },
    ]
    const ids = orderEdgesIntoChain(edges).map((ce) => ce.edge.id).join('')
    expect(['lc', 'cl']).toContain(ids)
  })
})

// XY plane: sketchToWorld2d([u,v]) -> [u, v, 0].
const planeXY = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
// Plane through (10,0,0) spanning world Z (its local x) and world Y (its local y).
const planeZ = { origin: [10, 0, 0], x_axis: [0, 0, 1], y_axis: [0, 1, 0], normal: [1, 0, 0] }

function repoWithPathSketches(): Repository {
  const repo = new Repository()
  // skX (XY): l1 (0,0)->(10,0), l2 (10,0)->(10,5).
  repo.register('_pt_skX', planeXY)
  repo.register('_topo_skX', {
    edges: [
      { entity_id: 'l1', edge_index: 0, kind: 'line', start: [0, 0], end: [10, 0] },
      { entity_id: 'l2', edge_index: 1, kind: 'line', start: [10, 0], end: [10, 5] },
    ],
  })
  // skZ (rises in world Z from (10,0,0)): l3 (0,0)->(5,0) -> world (10,0,0)->(10,0,5).
  repo.register('_pt_skZ', planeZ)
  repo.register('_topo_skZ', {
    edges: [{ entity_id: 'l3', edge_index: 0, kind: 'line', start: [0, 0], end: [5, 0] }],
  })
  return repo
}

// The two free (degree-1) endpoints of an ordered open chain, as sorted JSON
// (chain direction is not fixed, so compare the endpoint set, not positions).
function chainEnds(chain: ChainEdge[]): string[] {
  const counts = new Map<string, number>()
  for (const ce of chain) {
    for (const p of [ce.edge.start as number[], ce.edge.end as number[]]) {
      const k = JSON.stringify(p)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
  return [...counts.entries()].filter(([, n]) => n === 1).map(([k]) => k).sort()
}

describe('orderedPathWorldEdges', () => {
  it('selects only the picked entity edge (edge-precise)', () => {
    const [edges] = orderedPathWorldEdges(['entity:skX:l1'], repoWithPathSketches())
    expect(edges).toHaveLength(1)
    expect(edges[0].edge.start).toEqual([0, 0, 0])
    expect(edges[0].edge.end).toEqual([10, 0, 0])
    expect(edges[0].reversed).toBe(false)
  })

  it('orders multiple picked entity edges into a chain', () => {
    const [edges] = orderedPathWorldEdges(['entity:skX:l2', 'entity:skX:l1'], repoWithPathSketches())
    expect(edges).toHaveLength(2)
    expect(chainEnds(edges)).toEqual([JSON.stringify([0, 0, 0]), JSON.stringify([10, 5, 0])])
  })

  it('dedupes an edge picked via both whole-sketch and entity refs', () => {
    const [edges] = orderedPathWorldEdges(['skX', 'entity:skX:l1'], repoWithPathSketches())
    expect(edges).toHaveLength(2)  // l1 not double-counted
  })

  it('chains a path spanning two sketches on different planes (world ordering)', () => {
    const [edges, firstSketchId] = orderedPathWorldEdges(['entity:skX:l1', 'entity:skZ:l3'], repoWithPathSketches())
    expect(firstSketchId).toBe('skX')
    expect(edges).toHaveLength(2)
    // Free ends are (0,0,0) and (10,0,5); they meet at the plane seam (10,0,0).
    expect(chainEnds(edges)).toEqual([JSON.stringify([0, 0, 0]), JSON.stringify([10, 0, 5])])
  })

  it('throws when a path sketch is unknown', () => {
    expect(() => orderedPathWorldEdges(['$missing'], new Repository())).toThrow(/path sketch not found/)
  })

  it('resolves a line-arc-line spine picked edge-by-edge (bug: sweep_20260613_134746)', () => {
    // The corrected pipe sweep: the path is the three sketch-1 edges picked
    // individually. They must order into one open line -> arc -> line chain.
    const sk = 'bOhvSew-4vrj_rLeRX0-ZR78'
    const repo = new Repository()
    repo.register('_pt_' + sk, planeXY)
    repo.register('_topo_' + sk, {
      edges: [
        { entity_id: 'SN7Aax6PfaDQoVdM', edge_index: 0, kind: 'line', start: [0, 0], end: [-10, 0] },
        {
          entity_id: '6a0ityCkkAXICmG2', edge_index: 1, kind: 'arc',
          center: [-10, -5], radius: 5, start: [-10, 0], end: [-7.69, -9.43],
          angle_start_deg: 90, angle_end_deg: -62.48, ccw: false,
        },
        { entity_id: 'RJ5pRtfqTByhFHlV', edge_index: 2, kind: 'line', start: [-7.69, -9.43], end: [-1.33, -6.12] },
      ],
    })
    const [edges] = orderedPathWorldEdges([
      `entity:${sk}:SN7Aax6PfaDQoVdM`,
      `entity:${sk}:6a0ityCkkAXICmG2`,
      `entity:${sk}:RJ5pRtfqTByhFHlV`,
    ], repo)
    expect(edges).toHaveLength(3)
    expect(edges.map((ce) => ce.edge.kind)).toContain('arc')  // the arc is part of the spine
    // One connected open chain: exactly two free endpoints (origin + far line end).
    expect(chainEnds(edges)).toEqual([JSON.stringify([-1.33, -6.12, 0]), JSON.stringify([0, 0, 0])])
  })

  it('reverses a topology-normalized arc in the chain (bug: major-arc sweep)', () => {
    // After topology normalisation, an arc whose CCW span exceeds 180° has
    // its start/end swapped and ccw is always true for the forward edge.
    // The chain walk must reverse it to connect the preceding line, and
    // collectPathEdges must NOT build the major complement arc.
    // Pre-normalisation: arc goes from [-10,0] to [-7.69,-9.43] CW (152°).
    // Post-normalisation: start [-7.69,-9.43], end [-10,0], ccw=true.
    const sk = 'sk'
    const repo = new Repository()
    repo.register('_pt_' + sk, planeXY)
    repo.register('_topo_' + sk, {
      edges: [
        { entity_id: 'L1', edge_index: 0, kind: 'line', start: [0, 0], end: [-10, 0] },
        {
          entity_id: 'A1', edge_index: 1, kind: 'arc',
          center: [-10, -5], radius: 5,
          start: [-7.69, -9.43], end: [-10, 0],
          angle_start_deg: -62.48, angle_end_deg: 90, ccw: true,
        },
        { entity_id: 'L2', edge_index: 2, kind: 'line', start: [-7.69, -9.43], end: [-1.33, -6.12] },
      ],
    })
    const [edges] = orderedPathWorldEdges([
      `entity:${sk}:L1`, `entity:${sk}:A1`, `entity:${sk}:L2`,
    ], repo)
    expect(edges).toHaveLength(3)
    // The arc must be reversed: its end [-10,0] connects to L1's end.
    const arcEdge = edges.find((ce) => ce.edge.kind === 'arc')
    expect(arcEdge).toBeDefined()
    expect(arcEdge!.reversed).toBe(true)
    // Chain endpoints match: free end of L1 is [0,0,0], free end of L2 is [-1.33,-6.12,0].
    expect(chainEnds(edges)).toEqual([JSON.stringify([-1.33, -6.12, 0]), JSON.stringify([0, 0, 0])])
  })

  it('refuses a closed ellipse path entity by name (H14)', () => {
    // A full ellipse carries no start/end, so the pre-fix code threw a raw
    // TypeError out of sketchToWorld2d(undefined). It must refuse by name
    // instead: a closed curve has no open-chain endpoints to walk from.
    const repo = new Repository()
    repo.register('_pt_skE', planeXY)
    repo.register('_topo_skE', {
      edges: [{ entity_id: 'E1', edge_index: 0, kind: 'ellipse', center: [0, 0], a: 5, b: 3, theta: 0 }],
    })
    expect(() => orderedPathWorldEdges(['$skE'], repo)).toThrow(/closed ellipse/)
  })

  it('carries the exact ellipse_arc descriptor for a curved spine edge (H14)', () => {
    const repo = new Repository()
    repo.register('_pt_skE', planeXY)
    repo.register('_topo_skE', {
      edges: [{
        entity_id: 'EA1', edge_index: 0, kind: 'ellipse_arc',
        center: [0, 0], a: 5, b: 3, theta: 30,
        angle_start_deg: 0, angle_end_deg: 90, ccw: true,
        start: [5, 0], end: [0, 3],
      }],
    })
    const [edges] = orderedPathWorldEdges(['$skE'], repo)
    expect(edges).toHaveLength(1)
    const e = edges[0].edge
    expect(e._plane).toEqual(planeXY)
    expect(e._ellipse).toEqual({
      center: [0, 0], a: 5, b: 3, theta: 30,
      angle_start_deg: 0, angle_end_deg: 90, ccw: true,
    })
    // World start/end are still carried for chaining across sketches.
    expect(e.start).toEqual([5, 0, 0])
    expect(e.end).toEqual([0, 3, 0])
  })

  it('carries the exact spline descriptor for a curved spine edge (H14)', () => {
    const repo = new Repository()
    repo.register('_pt_skS', planeXY)
    repo.register('_topo_skS', {
      edges: [{
        entity_id: 'S1', edge_index: 0, kind: 'spline',
        start: [0, 0], c1: [0, -3], c2: [4, -3], end: [4, 0],
      }],
    })
    const [edges] = orderedPathWorldEdges(['$skS'], repo)
    expect(edges).toHaveLength(1)
    const e = edges[0].edge
    expect(e._plane).toEqual(planeXY)
    expect(e._spline).toEqual({ start: [0, 0], c1: [0, -3], c2: [4, -3], end: [4, 0] })
  })
})

describe('pathRefToSketchId', () => {
  it('reads the sketch id from an @feat/entity ref', () => {
    expect(pathRefToSketchId('@sk7/e3', new Repository())).toBe('sk7')
  })

  it('strips $ from a plain sketch ref', () => {
    expect(pathRefToSketchId('$sk9', new Repository())).toBe('sk9')
  })

  it('resolves a ?ancestry ref to the first sketch with topology', () => {
    const repo = new Repository()
    repo.register('_topo_skA', { edges: [] })
    expect(pathRefToSketchId('?4;@skA', repo)).toBe('skA')
  })

  it('throws when a ?ancestry ref names no known sketch', () => {
    expect(() => pathRefToSketchId('?5;@nope', new Repository())).toThrow(/could not resolve path sketch/)
  })
})

describe('solveSweep guard paths', () => {
  it('requires at least one profile reference', () => {
    expect(() =>
      solveSweep(oc, scope, table, { id: 'f1', sweep: { path: '$p' } }, new Repository(), {}),
    ).toThrow(/at least one profile reference/)
  })

  it('requires a path reference', () => {
    expect(() =>
      solveSweep(oc, scope, table, { id: 'f1', sweep: { sketch: '$sk' } }, new Repository(), {}),
    ).toThrow(/requires a path reference/)
  })

  it('surfaces an unresolved profile ref as the collected error', () => {
    const bodyStore: Record<string, Body> = {}
    expect(() =>
      solveSweep(
        oc,
        scope,
        table,
        { id: 'f1', sweep: { sketch: '$missing', path: '$p' } },
        new Repository(),
        bodyStore,
      ),
    ).toThrow(/sketch not found: missing/)
  })

  it('refuses a profile mixing a picked body face with sketch loops', () => {
    // Both a face ref and a loop ref resolved; the leaf sweeps only the loops,
    // so the mixed pick must be refused by name instead of silently dropping
    // the faces (which would leave profile_queries naming geometry the body
    // does not contain).
    const plane = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
    vi.mocked(collectExtrudeLoops).mockImplementation((_oc, _scope, _table, sketchRef) => {
      if (sketchRef === '@b1/face/0') {
        return { loops: [], plane, sketchId: 'skF', face: {} as OccShape }
      }
      return { loops: [[{ entity_id: 'e1' }]], plane, sketchId: 'skP', face: null }
    })
    expect(() =>
      solveSweep(
        oc,
        scope,
        table,
        { id: 'sw1', sweep: { sketch: ['@b1/face/0', '$sk'], path: '$p' } },
        new Repository(),
        {},
      ),
    ).toThrow(/mixing picked faces\/edges with sketch areas/)
  })

  it('resolves entity-selection profile refs to their parent sketch (bug: sweep_20260613)', () => {
    // The profile was picked edge-by-edge, persisting `entity:<sketchId>:<eid>`
    // selection IDs. These must collapse to the parent sketch, not surface the
    // cryptic "sketch not found: entity:..." that the bug report hit.
    const sketchId = 'bOhvSew-4vrj_rLeRX0-ZR78'
    let msg = ''
    try {
      solveSweep(
        oc,
        scope,
        table,
        {
          id: 'sw',
          sweep: {
            path: '$p',
            sketch: [`entity:${sketchId}:SN7Aax6PfaDQoVdM`, `entity:${sketchId}:6a0ityCkkAXICmG2`],
          },
        },
        new Repository(),
        {},
      )
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain(`sketch not found: ${sketchId}`)
    expect(msg).not.toContain('entity:')
  })
})
