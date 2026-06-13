// Always-on tests for the sweep leaf's OCC-free logic (phase 2f): the path-chain
// ordering, path-ref resolution, and solveSweep guard paths. The geometry-
// producing path is gated in occ/sweepReal.test.ts.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveSweep, orderEdgesIntoChain, pathRefToSketchId, profileRefToSketchRef, orderedPathWorldEdges } from './sweep'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable

type Edge = Record<string, unknown>

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
    const ids = ordered.map((e) => e.id).join('')
    expect(['abc', 'cba']).toContain(ids)
  })

  it('returns a single edge unchanged', () => {
    const edges: Edge[] = [{ id: 'only', start: [0, 0], end: [1, 1] }]
    expect(orderEdgesIntoChain(edges)).toEqual(edges)
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
    const ids = orderEdgesIntoChain(edges).map((e) => e.id).join('')
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
function chainEnds(edges: Edge[]): string[] {
  const counts = new Map<string, number>()
  for (const e of edges) {
    for (const p of [e.start as number[], e.end as number[]]) {
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
    expect(edges[0].start).toEqual([0, 0, 0])
    expect(edges[0].end).toEqual([10, 0, 0])
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
    expect(edges.map((e) => e.kind)).toContain('arc')  // the arc is part of the spine
    // One connected open chain: exactly two free endpoints (origin + far line end).
    expect(chainEnds(edges)).toEqual([JSON.stringify([-1.33, -6.12, 0]), JSON.stringify([0, 0, 0])])
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

describe('profileRefToSketchRef', () => {
  it('collapses an entity selection ID to its parent sketch id', () => {
    expect(profileRefToSketchRef('entity:bOhvSew-4vrj:SN7Aax6PfaDQoVdM')).toBe('bOhvSew-4vrj')
  })

  it('collapses a vertex selection ID to its parent sketch id', () => {
    expect(profileRefToSketchRef('vertex:sk1:e2:start')).toBe('sk1')
  })

  it('passes plain $/@/? refs through unchanged', () => {
    expect(profileRefToSketchRef('$sk1')).toBe('$sk1')
    expect(profileRefToSketchRef('@sk1/e2')).toBe('@sk1/e2')
    expect(profileRefToSketchRef('?3;@sk1')).toBe('?3;@sk1')
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
