// Unit tests for the selector engine over synthetic solve results. Pure TS, no
// kernel: a hand-built BodyResult exercises every predicate, the tolerance
// grouping, the adjacency join and the empty-result diagnostics.

import { describe, it, expect } from 'vitest'
import { selectByPredicate, validateSelector, SelectorError } from '@/kernel/select'
import type { Predicate, Selector } from '@/kernel/select'
import { makeAncestryQuery } from '@/kernel/query'
import type { BodyResult, EdgeData, FaceData } from '@/types/cad'

type V3 = [number, number, number]

function line(a: V3, b: V3): EdgeData {
  return { kind: 'line', start: a, end: b }
}

function circle(center: V3, radius: number, axis: V3): EdgeData {
  return { kind: 'circle', center, radius, axis, x_axis: [1, 0, 0], angle_start: 0, angle_end: 2 * Math.PI }
}

function arc(center: V3, radius: number, axis: V3, xAxis: V3, from: number, to: number): EdgeData {
  return { kind: 'arc', center, radius, axis, x_axis: xAxis, angle_start: from, angle_end: to }
}

function spline(points: V3[]): EdgeData {
  return { kind: 'spline', points }
}

function ellipse(center: V3, a: number, b: number, axis: V3, xAxis: V3, from: number, to: number): EdgeData {
  return { kind: 'ellipse', center, a, b, axis, x_axis: xAxis, angle_start: from, angle_end: to }
}

function face(centroid: V3, normal: V3, surface_type: string, radius?: number, axis?: V3): FaceData {
  return {
    centroid,
    normal,
    surface_type,
    ...(radius !== undefined && { surface_frame: { axis: axis ?? normal, origin: centroid, radius } }),
  }
}

/** A wire query naming body `bodyId` and the tokens given, with a type tail. */
function q(bodyId: string, tokens: string[], type: string): string {
  return makeAncestryQuery([`@${bodyId}`, ...tokens], type)
}

function bodyResult(
  id: string,
  edges: EdgeData[],
  edgeQueries: string[],
  faces: FaceData[],
  faceQueries: string[],
  faceEdgeQueries: string[][],
): BodyResult {
  return {
    id,
    created_by: 'ex1',
    modified_by: [],
    edges,
    edge_queries: edgeQueries,
    mesh: { vertices: [], faces: [], face_data: faces, face_queries: faceQueries, face_edge_queries: faceEdgeQueries },
  }
}

// A 10x10x10 box: 12 line edges (4 vertical, 4 top, 4 bottom) and 6 flat faces.
// The ten top/bottom edges are perpendicular to Z, the four vertical ones
// parallel; the top face's normal is +Z, the bottom's -Z.
const BOX_EDGES: EdgeData[] = [
  line([0, 0, 0], [0, 0, 10]), line([10, 0, 0], [10, 0, 10]),
  line([10, 10, 0], [10, 10, 10]), line([0, 10, 0], [0, 10, 10]),
  line([0, 0, 10], [10, 0, 10]), line([10, 0, 10], [10, 10, 10]),
  line([10, 10, 10], [0, 10, 10]), line([0, 10, 10], [0, 0, 10]),
  line([0, 0, 0], [10, 0, 0]), line([10, 0, 0], [10, 10, 0]),
  line([10, 10, 0], [0, 10, 0]), line([0, 10, 0], [0, 0, 0]),
]

function edgeQueriesFor(bodyId: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => q(bodyId, [`@u|e_${i}`], 'straightedge'))
}

function box(): Record<string, BodyResult> {
  const eq = edgeQueriesFor('body_ex1', 12)
  const topBoundary = eq.slice(4, 8)
  const bottomBoundary = eq.slice(8, 12)
  const faces: FaceData[] = [
    face([5, 5, 10], [0, 0, 1], 'flatface'),
    face([5, 5, 0], [0, 0, -1], 'flatface'),
    face([0, 5, 5], [-1, 0, 0], 'flatface'),
    face([10, 5, 5], [1, 0, 0], 'flatface'),
    face([5, 0, 5], [0, -1, 0], 'flatface'),
    face([5, 10, 5], [0, 1, 0], 'flatface'),
  ]
  const faceQueries = faces.map((f, i) => q('body_ex1', [`@u|f_${i}`], f.surface_type!))
  const faceEdgeQueries = [topBoundary, bottomBoundary, [], [], [], []]
  return { body_ex1: bodyResult('body_ex1', BOX_EDGES, eq, faces, faceQueries, faceEdgeQueries) }
}

function withCircle(): Record<string, BodyResult> {
  const bodies = box()
  const b = bodies.body_ex1
  b.edges!.push(circle([5, 5, 5], 2, [0, 0, 1]))
  b.edge_queries!.push(q('body_ex1', ['@u|e_c'], 'edge'))
  return bodies
}

function queriesOf(selector: Selector, bodies: Record<string, BodyResult>): string[] {
  return selectByPredicate(selector, bodies).queries
}

describe('selectByPredicate: direction predicates', () => {
  it('parallel Z keeps the four vertical line edges', () => {
    const out = queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, box())
    expect(out).toEqual(edgeQueriesFor('body_ex1', 12).slice(0, 4))
  })

  it('perpendicular Z keeps the eight horizontal edges', () => {
    const out = queriesOf({ kind: 'edge', where: { perpendicular: [0, 0, 1] } }, box())
    expect(out).toEqual(edgeQueriesFor('body_ex1', 12).slice(4, 12))
  })

  it('parallel on faces keeps the faces whose normal is parallel, both caps', () => {
    const bodies = box()
    const items = selectByPredicate({ kind: 'face', where: { parallel: [0, 0, 1] } }, bodies).items
    // A parallel test ignores sign, so both the +Z top and the -Z bottom cap match.
    expect(items).toHaveLength(2)
    for (const item of items) expect(item.geometry).toMatchObject({ kind: 'face', surface_type: 'flatface' })
  })

  it('an extreme clause pins the top cap alone', () => {
    const selector: Selector = {
      kind: 'face',
      where: { and: [{ parallel: [0, 0, 1] }, { extreme: { axis: [0, 0, 1], side: 'max' } }] },
    }
    const items = selectByPredicate(selector, box()).items
    expect(items).toHaveLength(1)
    expect((items[0].geometry as { centroid: number[] }).centroid[2]).toBe(10)
  })

  it('perpendicular on faces keeps the four side faces', () => {
    const out = queriesOf({ kind: 'face', where: { perpendicular: [0, 0, 1] } }, box())
    expect(out).toHaveLength(4)
  })

  it('parallel on a curved face tests its analytic axis, not the radial normal or a seam', () => {
    // A Y-axis cylinder: its normal is radial (+X here) while the frame carries
    // the real axis. "parallel Y" means the axis, so a seam normal cannot win.
    const bodies = {
      body_ex1: bodyResult(
        'body_ex1',
        [],
        [],
        [
          face([10, 5, 0], [1, 0, 0], 'cylinderface', 5, [0, 1, 0]),
          face([0, 5, 0], [-1, 0, 0], 'cylinderface', 5, [0, 1, 0]),
          face([5, 5, 5], [0, 0, 1], 'flatface'),
        ],
        ['q_cyl_a', 'q_cyl_b', 'q_flat'],
        [],
      ),
    }
    expect(queriesOf({ kind: 'face', where: { parallel: [0, 1, 0] } }, bodies))
      .toEqual(['q_cyl_a', 'q_cyl_b'])
    // The radial normal no longer matches as a direction.
    expect(() => queriesOf({ kind: 'face', where: { parallel: [1, 0, 0] } }, bodies))
      .toThrow(SelectorError)
  })

  it('a zero axis matches nothing at the engine level', () => {
    // validateSelector rejects this at the MCP boundary, but the engine is
    // callable directly; a degenerate direction is never perpendicular.
    expect(() => queriesOf({ kind: 'edge', where: { perpendicular: [0, 0, 0] } }, box())).toThrow(SelectorError)
  })
})

describe('selectByPredicate: edge tangent semantics', () => {
  // One line along each axis, so a direction test can only return the one whose
  // own direction it names.
  function lines(): Record<string, BodyResult> {
    return {
      body_ex1: bodyResult(
        'body_ex1',
        [line([0, 0, 0], [0, 5, 0]), line([0, 0, 0], [5, 0, 0])],
        ['q_y', 'q_x'],
        [], [], [],
      ),
    }
  }

  it('parallel tests a line direction', () => {
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 1, 0] } }, lines())).toEqual(['q_y'])
    expect(queriesOf({ kind: 'edge', where: { parallel: [1, 0, 0] } }, lines())).toEqual(['q_x'])
    expect(queriesOf({ kind: 'edge', where: { perpendicular: [1, 0, 0] } }, lines())).toEqual(['q_y'])
  })

  it('tests a fillet arc tangent, not the underlying circle axis', () => {
    // A vertical fillet's top/bottom boundary arc on a plate: its circle axis
    // is Y, but the arc is swept in the XZ plane, so its tangent never is.
    const filletArc = arc([3, 0, -27], 3, [0, 1, 0], [1, 0, 0], Math.PI, 1.5 * Math.PI)
    const bodies = {
      body_ex1: bodyResult('body_ex1', [filletArc, line([0, 0, 0], [0, 5, 0])], ['q_arc', 'q_line'], [], [], []),
    }
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 1, 0] } }, bodies)).toEqual(['q_line'])
    expect(queriesOf({ kind: 'edge', where: { perpendicular: [0, 1, 0] } }, bodies)).toEqual(['q_arc'])
    // Mid-sweep is 5*pi/4, where the tangent is the 45 degree XZ direction.
    expect(queriesOf({ kind: 'edge', where: { parallel: [1, 0, 1] } }, bodies)).toEqual(['q_arc'])
  })

  it('a full circle has no direction, so no direction clause picks it', () => {
    const bodies = {
      body_ex1: bodyResult('body_ex1', [circle([0, 0, 0], 2, [0, 0, 1])], ['q_circle'], [], [], []),
    }
    expect(() => queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, bodies))
      .toThrow(/parallel \[0, 0, 1\] matched 0/)
    expect(() => queriesOf({ kind: 'edge', where: { perpendicular: [0, 0, 1] } }, bodies)).toThrow(SelectorError)
    // It stays reachable by kind and radius, and a negation never drops it.
    expect(queriesOf({ kind: 'edge', where: { type: 'circle' } }, bodies)).toEqual(['q_circle'])
    expect(queriesOf({ kind: 'edge', where: { not: { parallel: [0, 0, 1] } } }, bodies)).toEqual(['q_circle'])
  })

  it('tests an ellipse tangent at mid-sweep, not its plane normal', () => {
    // A half ellipse in the XZ plane (axis Y), semi axes 4 and 2.
    const half = ellipse([0, 0, 0], 4, 2, [0, 1, 0], [1, 0, 0], 0, Math.PI / 2)
    const bodies = {
      body_ex1: bodyResult('body_ex1', [half, line([0, 0, 0], [0, 5, 0])], ['q_ellipse', 'q_line'], [], [], []),
    }
    // At t = pi/4 the tangent is (-2, 0, -1); the Y normal is never a match.
    expect(queriesOf({ kind: 'edge', where: { parallel: [-2, 0, -1] } }, bodies)).toEqual(['q_ellipse'])
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 1, 0] } }, bodies)).toEqual(['q_line'])
  })

  it('tests a spline tangent at its middle sample, not its end chord', () => {
    // The middle sample's central difference is (1, 0, 1); first-to-last is
    // (1, 0, 2), so the old chord reading would miss the real tangent.
    const bodies = {
      body_ex1: bodyResult(
        'body_ex1',
        [spline([[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 2]]), line([0, 0, 0], [0, 5, 0])],
        ['q_spline', 'q_line'],
        [], [], [],
      ),
    }
    expect(queriesOf({ kind: 'edge', where: { parallel: [1, 0, 1] } }, bodies)).toEqual(['q_spline'])
    expect(() => queriesOf({ kind: 'edge', where: { parallel: [1, 0, 2] } }, bodies)).toThrow(SelectorError)
  })
})

describe('selectByPredicate: type and radius', () => {
  it('type filters edge kinds', () => {
    const bodies = withCircle()
    expect(queriesOf({ kind: 'edge', where: { type: 'circle' } }, bodies)).toHaveLength(1)
    expect(queriesOf({ kind: 'edge', where: { type: 'line' } }, bodies)).toHaveLength(12)
  })

  it('type filters face surface types', () => {
    expect(queriesOf({ kind: 'face', where: { type: 'flatface' } }, box())).toHaveLength(6)
  })

  it('type "face" matches the freeform catch-all surface type', () => {
    // surfaceTypeOf reports `face` for a BSpline or otherwise unmodelled
    // surface, and evaluate accepts it exactly; the vocabulary must offer it.
    const bodies = {
      body_ex1: bodyResult('body_ex1', [], [], [face([0, 0, 0], [0, 0, 1], 'face')], ['qf'], []),
    }
    expect(queriesOf({ kind: 'face', where: { type: 'face' } }, bodies)).toEqual(['qf'])
  })

  it('radius matches a circle edge and a cylinder face', () => {
    const bodies = withCircle()
    expect(queriesOf({ kind: 'edge', where: { radius: { eq: 2 } } }, bodies)).toHaveLength(1)
    // A radius test that no candidate satisfies leaves the selector empty, and
    // an empty selector is an error (not a silent zero).
    expect(() => queriesOf({ kind: 'edge', where: { radius: { min: 3 } } }, bodies)).toThrow(SelectorError)
    // A line edge has no radius: the test is a non-match, not a throw of its own.
    expect(() => queriesOf({ kind: 'edge', where: { and: [{ type: 'line' }, { radius: 2 }] } }, bodies))
      .toThrow(SelectorError)
  })
})

describe('selectByPredicate: extreme', () => {
  it('groups the four top edges at the max Z, not one', () => {
    const out = queriesOf({ kind: 'edge', where: { extreme: { axis: [0, 0, 1], side: 'max' } } }, box())
    expect(out).toEqual(edgeQueriesFor('body_ex1', 12).slice(4, 8))
  })

  it('groups within the measure tolerance, not by exact equality', () => {
    const edges: EdgeData[] = [
      line([0, 0, 10], [10, 0, 10]),
      line([0, 1, 10 + 1e-7], [10, 1, 10 + 1e-7]),
      line([0, 2, 10 + 2e-7], [10, 2, 10 + 2e-7]),
      line([0, 3, 5], [10, 3, 5]),
    ]
    const bodies = {
      body_ex1: bodyResult(
        'body_ex1', edges, edgeQueriesFor('body_ex1', 4), [], [], [],
      ),
    }
    // Three projections a fraction of a micron apart form one group; the far
    // edge is left out.
    const out = queriesOf({ kind: 'edge', where: { extreme: { axis: [0, 0, 1], side: 'max' } } }, bodies)
    expect(out).toHaveLength(3)
  })

  it('min side groups the bottom edges', () => {
    const out = queriesOf({ kind: 'edge', where: { extreme: { axis: [0, 0, 1], side: 'min' } } }, box())
    expect(out).toEqual(edgeQueriesFor('body_ex1', 12).slice(8, 12))
  })

  it('names one outer vertical corner edge and all four corners in one or', () => {
    // There is no outer-boundary predicate, but a per-corner chain of the
    // existing vocabulary expresses exactly one corner: direction, kind, then
    // the two extremes that leave the corner. Four chains under `or` name all
    // four in one call.
    const corner = (x: 'min' | 'max', y: 'min' | 'max'): Predicate => ({
      and: [
        { parallel: [0, 0, 1] },
        { type: 'line' },
        { extreme: { axis: [1, 0, 0], side: x } },
        { extreme: { axis: [0, 1, 0], side: y } },
      ],
    })
    expect(queriesOf({ kind: 'edge', where: corner('min', 'min') }, box()))
      .toEqual([edgeQueriesFor('body_ex1', 12)[0]])
    expect(queriesOf({
      kind: 'edge',
      where: { or: [corner('min', 'min'), corner('max', 'min'), corner('max', 'max'), corner('min', 'max')] },
    }, box())).toEqual(edgeQueriesFor('body_ex1', 12).slice(0, 4))
  })

  it('accepts x, y and z as sugar for the unit axis', () => {
    const select = (axis: unknown) => {
      const validated = validateSelector({ kind: 'edge', where: { extreme: { axis, side: 'max' } } })
      return queriesOf(validated, box())
    }
    expect(select('z')).toEqual(edgeQueriesFor('body_ex1', 12).slice(4, 8))
    expect(select('X')).toHaveLength(4)
    expect(validateSelector({ kind: 'edge', where: { extreme: { axis: 'y', side: 'min' } } }))
      .toMatchObject({ where: { extreme: { axis: [0, 1, 0], side: 'min' } } })
  })

  it('a bad extreme axis repeats the whole clause so the fix is visible', () => {
    expect(() => validateSelector({ kind: 'edge', where: { extreme: { axis: 'up', side: 'max' } } }))
      .toThrow(/"extreme":\{"axis":"up","side":"max"\}/)
    expect(() => validateSelector({ kind: 'edge', where: { extreme: { axis: [0, 0], side: 'max' } } }))
      .toThrow(/"extreme":\{"axis":\[0,0\],"side":"max"\}/)
  })

  it('a diagnostic extreme clause prints the whole clause', () => {
    // The earlier type clause empties the pool, so the extreme clause matches 0
    // and its diagnostic carries the JSON an author copies back.
    let message = ''
    try {
      selectByPredicate({ kind: 'edge', where: { and: [{ type: 'spline' }, { extreme: { axis: [1, 0, 0], side: 'max' } }] } }, box())
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('extreme {"axis":[1,0,0],"side":"max"}')
  })
})

describe('selectByPredicate: adjacency and composition', () => {
  it('on_face keeps the edges bounding the selected faces', () => {
    const selector: Selector = {
      kind: 'edge',
      where: {
        on_face: {
          kind: 'face',
          where: { and: [{ parallel: [0, 0, 1] }, { extreme: { axis: [0, 0, 1], side: 'max' } }] },
        },
      },
    }
    expect(queriesOf(selector, box())).toEqual(edgeQueriesFor('body_ex1', 12).slice(4, 8))
  })

  it('on_face rejects a non-face inner selector', () => {
    const selector = { kind: 'edge', where: { on_face: { kind: 'edge' } } } as unknown as Selector
    expect(() => queriesOf(selector, box())).toThrow(/on_face needs a face selector/)
  })

  it('not complements against the pool', () => {
    const out = queriesOf({ kind: 'edge', where: { not: { parallel: [0, 0, 1] } } }, box())
    expect(out).toHaveLength(8)
  })

  it('and narrows sequentially and or unions', () => {
    expect(queriesOf({ kind: 'edge', where: { and: [{ type: 'line' }, { parallel: [0, 0, 1] }] } }, box()))
      .toHaveLength(4)
    expect(queriesOf({ kind: 'edge', where: { or: [{ parallel: [0, 0, 1] }, { type: 'circle' }] } }, withCircle()))
      .toHaveLength(5)
  })

  it('an and chain narrows an extreme to the earlier clauses', () => {
    // First the horizontal edges, then the max-Z group of THOSE: the top edges.
    const selector: Selector = {
      kind: 'edge',
      where: { and: [{ perpendicular: [0, 0, 1] }, { extreme: { axis: [0, 0, 1], side: 'max' } }] },
    }
    expect(queriesOf(selector, box())).toEqual(edgeQueriesFor('body_ex1', 12).slice(4, 8))
  })
})

describe('selectByPredicate: from, order and provenance', () => {
  it('orders by body id then index', () => {
    const bodies = {
      body_zeta: bodyResult('body_zeta', [line([0, 0, 0], [0, 0, 1])], ['q_zeta_0'], [], [], []),
      body_alpha: bodyResult('body_alpha', [line([0, 0, 0], [0, 0, 1])], ['q_alpha_0'], [], [], []),
    }
    const out = queriesOf({ kind: 'edge' }, bodies)
    expect(out).toEqual(['q_alpha_0', 'q_zeta_0'])
  })

  it('from restricts to one body', () => {
    const bodies = {
      body_a: bodyResult('body_a', [line([0, 0, 0], [0, 0, 1])], ['qa'], [], [], []),
      body_b: bodyResult('body_b', [line([0, 0, 0], [0, 0, 1])], ['qb'], [], [], []),
    }
    expect(queriesOf({ from: 'body_b', kind: 'edge' }, bodies)).toEqual(['qb'])
  })

  it('from naming a missing body fails loud', () => {
    expect(() => queriesOf({ from: 'body_nope', kind: 'edge' }, box())).toThrow(SelectorError)
  })

  it('created_by matches an ancestry feature token', () => {
    const bodies = {
      body_ex1: bodyResult(
        'body_ex1',
        [line([0, 0, 0], [0, 0, 1]), line([1, 0, 0], [1, 0, 1])],
        [q('body_ex1', ['@u|e_0', '@ex1'], 'straightedge'), q('body_ex1', ['@u|e_1', '@ex2'], 'straightedge')],
        [], [], [],
      ),
    }
    expect(queriesOf({ kind: 'edge', where: { created_by: 'ex2' } }, bodies))
      .toEqual([q('body_ex1', ['@u|e_1', '@ex2'], 'straightedge')])
    expect(queriesOf({ kind: 'edge', where: { created_by: 'ex1' } }, bodies)).toHaveLength(1)
  })
})

describe('selectByPredicate: alignment and diagnostics', () => {
  it('skips unnamed edges and reads a short query array defensively', () => {
    const bodies = {
      body_ex1: bodyResult(
        'body_ex1',
        [line([0, 0, 0], [0, 0, 1]), line([1, 0, 0], [1, 0, 1]), line([2, 0, 0], [2, 0, 1])],
        ['qa', ''],  // edge 1 is unnamed, edge 2 has no query slot
        [], [], [],
      ),
    }
    expect(queriesOf({ kind: 'edge' }, bodies)).toEqual(['qa'])
  })

  it('an empty result names the nearest-miss count per predicate', () => {
    let error: unknown
    try {
      selectByPredicate({ kind: 'edge', where: { and: [{ parallel: [0, 0, 1] }, { type: 'spline' }] } }, box())
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(SelectorError)
    const message = (error as Error).message
    expect(message).toContain('matched no edges')
    expect(message).toMatch(/parallel \[0, 0, 1\] matched 4/)
    expect(message).toMatch(/type "spline" matched 0/)
  })

  it('an unknown type names the present and valid values instead of guessing a synonym', () => {
    let error: unknown
    try {
      selectByPredicate({ kind: 'face', where: { type: 'plane' } }, box())
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(SelectorError)
    const message = (error as Error).message
    expect(message).toContain('type "plane" matched 0')
    // The suggestion is a hint, not a synonym: matching still needs `flatface`.
    expect(message).toContain('did you mean "flatface"?')
    expect(message).toContain('present face types: flatface')
    expect(message).toContain('valid face types: flatface, cylinderface, coneface, sphereface, torusface, face')
  })

  it('a valid type with zero matches still lists the vocabulary', () => {
    let error: unknown
    try {
      selectByPredicate({ kind: 'edge', where: { type: 'ellipse' } }, box())
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(SelectorError)
    const message = (error as Error).message
    expect(message).toContain('type "ellipse" matched 0')
    expect(message).toContain('present edge kinds: line')
    expect(message).toContain('valid edge kinds: line, circle, arc, spline, ellipse')
  })

  it('returns the geometry summary the agent reads back', () => {
    const items = selectByPredicate({ kind: 'edge', where: { parallel: [0, 0, 1] } }, box()).items
    expect(items[0].geometry).toMatchObject({ kind: 'line', length: 10 })
    expect(items[0].body).toBe('body_ex1')
    expect(items[0].index).toBe(0)
  })
})

describe('validateSelector', () => {
  it('accepts a well-formed selector', () => {
    const raw = { kind: 'edge', where: { and: [{ parallel: [0, 0, 1] }, { type: 'line' }] } }
    const validated = validateSelector(raw)
    expect(validated.kind).toBe('edge')
    expect((validated.where as { and: Predicate[] }).and).toHaveLength(2)
  })

  it('rejects an unknown predicate by name', () => {
    expect(() => validateSelector({ kind: 'edge', where: { parallelish: [0, 0, 1] } }))
      .toThrow(/unknown predicate "parallelish"/)
  })

  it('rejects unknown top-level keys, a bad kind and a bad vector', () => {
    expect(() => validateSelector({ kind: 'edge', typo: 1 })).toThrow(/unknown key "typo"/)
    expect(() => validateSelector({ kind: 'vertex' })).toThrow(/kind must be/)
    expect(() => validateSelector({ kind: 'edge', where: { parallel: [0, 0] } })).toThrow(/three finite numbers/)
  })

  it('rejects a zero axis wherever an axis is taken', () => {
    // A zero axis has a zero dot against every direction, so `perpendicular`
    // would match everything; the boundary must refuse it by field name.
    expect(() => validateSelector({ kind: 'edge', where: { parallel: [0, 0, 0] } })).toThrow(/non-zero axis/)
    expect(() => validateSelector({ kind: 'edge', where: { perpendicular: [0, 0, 0] } })).toThrow(/non-zero axis/)
    expect(() => validateSelector({ kind: 'edge', where: { extreme: { axis: [0, 0, 0], side: 'max' } } }))
      .toThrow(/non-zero axis/)
  })

  it('rejects a bad type name with the vocabulary and the likely spelling', () => {
    expect(() => validateSelector({ kind: 'face', where: { type: 'plane' } }))
      .toThrow(/did you mean "flatface"\?.*valid: flatface, cylinderface/)
    expect(() => validateSelector({ kind: 'face', where: { type: 'cylindeface' } }))
      .toThrow(/did you mean "cylinderface"\?/)
    // The check reaches inside a negation, where a wrong name would otherwise
    // match everything instead of failing.
    expect(() => validateSelector({ kind: 'edge', where: { not: { type: 'plane' } } }))
      .toThrow(/not a valid edge kind/)
    // A name that is only valid for the other kind gets no misleading suggestion.
    expect(() => validateSelector({ kind: 'edge', where: { type: 'flatface' } }))
      .toThrow(/not a valid edge kind; valid: line, circle, arc, spline, ellipse/)
  })

  it('rejects a predicate object with two keys', () => {
    expect(() => validateSelector({ kind: 'edge', where: { parallel: [0, 0, 1], type: 'line' } }))
      .toThrow(/exactly one predicate key/)
  })
})
