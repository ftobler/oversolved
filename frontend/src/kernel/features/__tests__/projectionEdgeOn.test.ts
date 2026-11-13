// @vitest-environment node
//
// The solve-level half of edge-on curve projection: a projected entity whose
// source is seen edge-on adopts the `line` kind (a stored degenerate ellipse
// re-lowers on its next solve, no migration), and a declared `point` on a
// curved source is that curve's centre. Skips when the Rust solver is absent.

import { describe, it, expect, beforeEach } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
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

describe('solveSketch lowers an edge-on curve to a line', () => {
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
      { id: 'cc', kind: 'coincident', reason: 'operand center not on line' },
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
      { id: 'cc', kind: 'coincident', reason: 'operand center not on line' },
      { id: 'eq', kind: 'equal_length', reason: 'equal_length does not apply to line and circle' },
    ])
    // Neither row left the document, and neither free entity was dragged.
    expect(feature.constraints).toHaveLength(3)
    expect(out.geometry?.u0).toEqual([10, 0, 2])
  })

  // A line -> point kind change would drop `start`/`end` on the same rule; that
  // transition belongs to its own plan.
  it.todo('16. drops a start row on a line that resolves to a point '
    + '(feature/projection-perpendicular-line.md)')
})
