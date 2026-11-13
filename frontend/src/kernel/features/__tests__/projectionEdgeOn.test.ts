// @vitest-environment node
//
// The solve-level half of projection kind re-resolution: a projected entity
// whose source is seen edge-on adopts the `line` kind (a stored degenerate
// ellipse re-lowers on its next solve, no migration), a line perpendicular to
// the plane adopts the `point` kind, and a declared `point` on a curved source
// is that curve's centre. A constraint naming a key the resolved kind does not
// have is dropped with a `dropped_constraints` record and revives when the
// source turns back. Skips when the Rust solver is absent.

import { describe, it, expect, beforeEach } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from '../sketch'
import { applyGeometryToFeature } from '@/utils/yamlMutations/solveResult'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { PartDoc } from '@/types/cad'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'

type Dict = Record<string, unknown>

const solveBytes = loadSolver()

/** A repository over a fixed element map, keyed the way the slash registry
 *  stores it (`@` stripped). */
function repoOf(entries: Record<string, unknown>): Repository {
  return {
    query: (q: string) => {
      const key = q.startsWith('@') ? q.slice(1) : q
      return (key in entries ? entries[key] : null) as never
    },
    elements: new Map<string, unknown>(Object.entries(entries)),
  } as unknown as Repository
}

/** A repository stub answering every query with one payload. */
function stubRepo(payload: Dict): Repository {
  return { query: () => payload, elements: new Map() } as unknown as Repository
}

function sketchWith(feature: Dict): Dict {
  return {
    id: 'sk2', kind: 'sketch', plane: '@builtin_plane_front',
    initial: {},
    constraints: [],
    ...feature,
  }
}

describe('solveSketch re-resolves a projected kind seen edge-on or end-on', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  // A sketch on Right holds a circle centred at world (0, 5, 0), radius 3. Its
  // axis is the Right frame normal (+X), which is perpendicular to the Front
  // sketch plane, so the whole curve is seen edge-on there.
  const RIGHT = { origin: [0, 0, 0], x_axis: [0, 0, -1], y_axis: [0, 1, 0], normal: [1, 0, 0] }
  const SKETCH_ENTRIES = {
    'sk1/c0': { external_params: [0, 5, 3], kind: 'circle', sketch_id: 'sk1' },
    _pt_sk1: RIGHT,
  }

  it('9. adopts the line kind from a perpendicular sketch-entity circle source', () => {
    if (!solveBytes) return
    const out = solveSketch(
      sketchWith({
        entities: [{ id: 'held', kind: 'circle' }],
        constraints: [{ id: 'proj_held', kind: 'projection', target: '$held', source: '@sk1/c0' }],
      }),
      repoOf(SKETCH_ENTRIES),
      {} as Record<string, Body>,
    )
    expect(out.projection_errors).toBeUndefined()
    const g = out.geometry?.held
    expect(g).toHaveLength(4)
    expect(out.resolved_kinds).toEqual({ held: 'line' })
    // The silhouette runs along world y through the projected centre (0, 5):
    // the Front sketch plane's local axes are world x/y.
    expect(Math.min(g![0], g![2])).toBeCloseTo(0)
    expect(Math.max(g![0], g![2])).toBeCloseTo(0)
    expect(Math.min(g![1], g![3])).toBeCloseTo(2)
    expect(Math.max(g![1], g![3])).toBeCloseTo(8)
  })

  it('10. re-lowers a stored degenerate ellipse on its next solve, without a migration', () => {
    if (!solveBytes) return
    // The bug document holds `kind: ellipse, [0, 0, 1.8, 0, 0]` from the old
    // lowering. The kind is re-resolved every solve, so the same doc heals.
    const edgeOnCircle: Dict = {
      type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 1.8, axis: [1, 0, 0], x_axis: [0, 1, 0],
    }
    const out = solveSketch(
      sketchWith({
        entities: [{ id: 'held', kind: 'ellipse' }],
        initial: { held: [0, 0, 1.8, 0, 0] },
        constraints: [{ id: 'proj_held', kind: 'projection', target: '$held', source: '?edge;circle' }],
      }),
      stubRepo(edgeOnCircle),
      {} as Record<string, Body>,
    )
    expect(out.projection_errors).toBeUndefined()
    expect(out.geometry?.held).toHaveLength(4)
    expect(out.resolved_kinds).toEqual({ held: 'line' })
  })

  // A Front sketch holding a projected line and a point coincident to its
  // start, authored while the projection is a real line. Each test builds a
  // fresh one: the write-back (not the solve) adopts the resolved kind, so
  // sharing one instance would carry that state between tests.
  function startRowFeature(): Dict {
    return sketchWith({
      entities: [{ id: 'l0', kind: 'line' }, { id: 'p0', kind: 'point' }],
      initial: { p0: [10, 10] },
      constraints: [
        { id: 'proj_l0', kind: 'projection', target: '$l0', source: '?edge;line' },
        { id: 'cc', kind: 'coincident', a: '$p0xy', b: '$l0start' },
      ],
    })
  }

  // The source line runs along world +Z, the Front plane's normal, so its
  // projection is one point.
  const endOnLine: Dict = { type: 'edge', kind: 'line', start: [2, 3, -4], end: [2, 3, 6] }
  // The same line swung 7 units along +X: Front-local (2, 3) -> (9, 3).
  const slantLine: Dict = { type: 'edge', kind: 'line', start: [2, 3, -4], end: [9, 3, 6] }

  it('16. drops a start row on a line that resolves to a point', () => {
    if (!solveBytes) return
    // The coincident authored on the line's start has no start key on the
    // resolved point, so the kind-change rule drops it by name and leaves the
    // free point where it was; the row stays in the document.
    const feature = startRowFeature()
    const out = solveSketch(feature, stubRepo(endOnLine), {} as Record<string, Body>)
    expect(out.projection_errors).toBeUndefined()
    expect(out.resolved_kinds).toEqual({ l0: 'point' })
    expect(out.geometry?.l0).toEqual([2, 3])
    expect(out.dropped_constraints).toEqual([
      { id: 'cc', kind: 'coincident', reason: 'operand start not on point' },
    ])
    expect(feature.constraints).toHaveLength(2)
    // The free point is not dragged onto the projected point.
    expect(out.geometry?.p0).toEqual([10, 10])
  })

  it('17. a line that leaves perpendicular resolves back to a line and the retained row lowers again', () => {
    if (!solveBytes) return
    // The same document across two solves, the way a session sees it: the
    // write-back adopts the resolved kind on the entity row (the lowering no
    // longer edits the input), so the second solve reports the flip back and the
    // retained row is valid again.
    const feature = startRowFeature()
    const endOn = solveSketch(feature, stubRepo(endOnLine), {} as Record<string, Body>)
    expect(endOn.resolved_kinds).toEqual({ l0: 'point' })
    expect(endOn.dropped_constraints).toHaveLength(1)
    // The document row only changes through the write-back, not during solving.
    expect((feature.entities as Array<{ id: string; kind: string }>)[0].kind).toBe('line')
    const doc = { version: 7, kind: 'part', features: [feature] } as unknown as PartDoc
    applyGeometryToFeature(doc, feature.id as string, endOn.geometry ?? {}, undefined, {
      resolvedKinds: endOn.resolved_kinds,
    })
    expect((feature.entities as Array<{ id: string; kind: string }>)[0].kind).toBe('point')

    const back = solveSketch(feature, stubRepo(slantLine), {} as Record<string, Body>)
    expect(back.projection_errors).toBeUndefined()
    // Point -> line is a real kind change: the entity row says `point` after the
    // write-back, so the second resolve is reported and the row binds the
    // projected segment's start again.
    expect(back.resolved_kinds).toEqual({ l0: 'line' })
    expect(back.dropped_constraints).toBeUndefined()
    // The pinned projection round-trips through the solver a few 1e-11 off the
    // lowered params; the start the retained row binds is the solved one.
    const g = back.geometry!.l0
    expect(g[0]).toBeCloseTo(2, 6)
    expect(g[1]).toBeCloseTo(3, 6)
    expect(g[2]).toBeCloseTo(9, 6)
    expect(g[3]).toBeCloseTo(3, 6)
    expect(back.geometry?.p0?.[0]).toBeCloseTo(2, 6)
    expect(back.geometry?.p0?.[1]).toBeCloseTo(3, 6)
    expect(feature.constraints).toHaveLength(2)
  })
})

describe('solveSketch projects a declared point on a curved source as its centre', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  // A circle parallel to the Front sketch plane, as a body edge query resolves.
  const parallelCircle: Dict = {
    type: 'edge', kind: 'circle', center: [3, 4, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0],
  }

  const projected = (kind: string, source: string): Dict =>
    sketchWith({
      entities: [{ id: 'e0', kind }],
      constraints: [{ id: 'proj_e0', kind: 'projection', target: '$e0', source }],
    })

  it('11a. a declared point on a body circle edge stays a point at its centre', () => {
    if (!solveBytes) return
    const out = solveSketch(projected('point', '?edge;circle'), stubRepo(parallelCircle), {} as Record<string, Body>)
    expect(out.projection_errors).toBeUndefined()
    expect(out.geometry?.e0).toEqual([3, 4])
    expect(out.resolved_kinds).toBeUndefined()
  })

  it('11b. a stored entity declared circle keeps the old resolved-kind behaviour', () => {
    if (!solveBytes) return
    // Existing documents adopted `circle` when the centre rule did not exist,
    // so their declared kind is the curve and the declared point rule cannot
    // reach them.
    const out = solveSketch(projected('circle', '?edge;circle'), stubRepo(parallelCircle), {} as Record<string, Body>)
    expect(out.geometry?.e0).toEqual([3, 4, 5])
    expect(out.resolved_kinds).toBeUndefined()
  })

  it('11c. a declared point on a line source still takes the resolved line', () => {
    if (!solveBytes) return
    const line: Dict = { type: 'edge', kind: 'line', start: [0, 0, 0], end: [4, 2, 0] }
    const out = solveSketch(projected('point', '?edge;line'), stubRepo(line), {} as Record<string, Body>)
    expect(out.geometry?.e0).toEqual([0, 0, 4, 2])
    expect(out.resolved_kinds).toEqual({ e0: 'line' })
  })

  it('11d. a declared point on another sketch\'s circle is that circle\'s centre', () => {
    if (!solveBytes) return
    // The same shape as `@sk/c/center`, reached by the declared kind instead of
    // the vertex key, so both spellings stay available.
    const right = { origin: [0, 0, 0], x_axis: [0, 0, -1], y_axis: [0, 1, 0], normal: [1, 0, 0] }
    const out = solveSketch(
      projected('point', '@sk1/c0'),
      repoOf({
        'sk1/c0': { external_params: [0, 5, 3], kind: 'circle', sketch_id: 'sk1' },
        _pt_sk1: right,
      }),
      {} as Record<string, Body>,
    )
    expect(out.projection_errors).toBeUndefined()
    // Front-plane local axes are world x/y; the source centre is world (0,5,0).
    expect(out.geometry?.e0).toEqual([0, 5])
    expect(out.resolved_kinds).toBeUndefined()
  })

  it('11e. the /center vertex spelling reads the same point through external_xy', () => {
    if (!solveBytes) return
    // A vertex ref resolves to `external_xy` before `resolve3dGeometry` runs, a
    // separate lift; the centre must land on the same point as 11d.
    const right = { origin: [0, 0, 0], x_axis: [0, 0, -1], y_axis: [0, 1, 0], normal: [1, 0, 0] }
    const out = solveSketch(
      projected('point', '@sk1/c0/center'),
      repoOf({
        'sk1/c0/center': { external_xy: [0, 5], sketch_id: 'sk1' },
        _pt_sk1: right,
      }),
      {} as Record<string, Body>,
    )
    expect(out.projection_errors).toBeUndefined()
    expect(out.geometry?.e0).toEqual([0, 5])
  })

  it('15a. a circle -> line kind change keeps the contract row and drops it by name', () => {
    if (!solveBytes) return
    // Executable pin of today's observable: the projected entity resolves to a
    // line, the coincident on its `center` is dropped with the key named (not
    // rebound to the line's start), and the document keeps the row so tilting
    // the source back re-enables it.
    const feature = sketchWith({
      entities: [{ id: 'c0', kind: 'circle' }, { id: 'p0', kind: 'point' }],
      initial: { p0: [10, 10] },
      constraints: [
        { id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' },
        { id: 'cc', kind: 'coincident', a: '$p0xy', b: '$c0center' },
      ],
    })
    const edgeOnCircle: Dict = {
      type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5, axis: [1, 0, 0], x_axis: [0, 1, 0],
    }
    const out = solveSketch(feature, stubRepo(edgeOnCircle), {} as Record<string, Body>)
    expect(out.resolved_kinds).toEqual({ c0: 'line' })
    expect(out.dropped_constraints).toEqual([
      {
        id: 'cc', kind: 'coincident',
        reason: 'operand center not on line; project the center as a point to keep it',
      },
    ])
    expect(feature.constraints).toHaveLength(2)
    // The free point is not dragged onto the silhouette's start.
    expect(out.geometry?.p0).toEqual([10, 10])
  })

  it('15b. an edge-on resolved kind also drops the constraint kinds it cannot take', () => {
    if (!solveBytes) return
    // Same edge-on circle, a second row the line kind cannot represent: an
    // `equal_length` to a user circle. Both rows are authored while the
    // projection resolved as a circle, then the centre key and the pair kind
    // run out of meaning together. The user circle keeps its radius, so the
    // drop is not a silent rebind onto the silhouette.
    const feature = sketchWith({
      entities: [{ id: 'c0', kind: 'circle' }, { id: 'u0', kind: 'circle' }],
      initial: { u0: [10, 0, 2] },
      constraints: [
        { id: 'proj_c0', kind: 'projection', target: '$c0', source: '?edge;circle' },
        { id: 'cc', kind: 'coincident', a: '$u0center', b: '$c0center' },
        { id: 'eq', kind: 'equal_length', a: '$c0', b: '$u0' },
      ],
    })
    const edgeOnCircle: Dict = {
      type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5, axis: [1, 0, 0], x_axis: [0, 1, 0],
    }
    const out = solveSketch(feature, stubRepo(edgeOnCircle), {} as Record<string, Body>)
    expect(out.resolved_kinds).toEqual({ c0: 'line' })
    expect(out.dropped_constraints).toEqual([
      {
        id: 'cc', kind: 'coincident',
        reason: 'operand center not on line; project the center as a point to keep it',
      },
      { id: 'eq', kind: 'equal_length', reason: 'equal_length does not apply to line and circle' },
    ])
    // Neither row left the document, and neither free entity was dragged.
    expect(feature.constraints).toHaveLength(3)
    expect(out.geometry?.u0).toEqual([10, 0, 2])
  })
})
