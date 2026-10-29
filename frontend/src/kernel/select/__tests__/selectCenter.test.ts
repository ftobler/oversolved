// Unit tests for the `center` point predicate: an element's centre point must
// lie within `radius` of the named world point. Pure TS over synthetic solve
// results.

import { describe, it, expect } from 'vitest'
import { selectByPredicate, validateSelector, SelectorError } from '@/kernel/select'
import type { Selector } from '@/kernel/select'
import type { BodyResult, EdgeData, FaceData } from '@/types/cad'

type V3 = [number, number, number]

function line(a: V3, b: V3): EdgeData {
  return { kind: 'line', start: a, end: b }
}

function circle(center: V3, radius: number, axis: V3): EdgeData {
  return { kind: 'circle', center, radius, axis, x_axis: [1, 0, 0], angle_start: 0, angle_end: 2 * Math.PI }
}

function bodyResult(
  id: string,
  edges: EdgeData[],
  edgeQueries: string[],
  faces: FaceData[] = [],
  faceQueries: string[] = [],
): BodyResult {
  return {
    id,
    created_by: 'ex1',
    modified_by: [],
    edges,
    edge_queries: edgeQueries,
    mesh: { vertices: [], faces: [], face_data: faces, face_queries: faceQueries },
  }
}

// Two parallel lines: one centred at (5,0,0), one at (5,0,5). A circle adds a
// curve whose centre point is its circle centre, far from both.
function edges(): Record<string, BodyResult> {
  return {
    body_ex1: bodyResult(
      'body_ex1',
      [
        line([0, 0, 0], [10, 0, 0]),
        line([0, 0, 5], [10, 0, 5]),
        circle([50, 0, 0], 2, [0, 0, 1]),
      ],
      ['q_near', 'q_far', 'q_circle'],
    ),
  }
}

function queriesOf(selector: Selector, bodies: Record<string, BodyResult>): string[] {
  return selectByPredicate(selector, bodies).queries
}

describe('selectByPredicate: center', () => {
  it('matches the edge whose centre is the named point', () => {
    expect(queriesOf({ kind: 'edge', where: { center: { point: [5, 0, 0] } } }, edges()))
      .toEqual(['q_near'])
  })

  it('matches a curve by its circle centre, the same point the summary reports', () => {
    expect(queriesOf({ kind: 'edge', where: { center: { point: [50, 0, 0] } } }, edges()))
      .toEqual(['q_circle'])
  })

  it('rejects an edge near but outside the radius', () => {
    // (5,0,0.5) is 0.5 from the near line's centre; a 0.4 radius excludes it.
    expect(() => queriesOf({ kind: 'edge', where: { center: { point: [5, 0, 0.5], radius: 0.4 } } }, edges()))
      .toThrow(SelectorError)
    // A 0.6 radius reaches it, so the radius is inclusive.
    expect(queriesOf({ kind: 'edge', where: { center: { point: [5, 0, 0.5], radius: 0.6 } } }, edges()))
      .toEqual(['q_near'])
  })

  it('the default radius is the measure tolerance, so only an exact point matches', () => {
    expect(() => queriesOf({ kind: 'edge', where: { center: { point: [5, 0, 0.001] } } }, edges()))
      .toThrow(SelectorError)
    // A bare radius of 0 still absorbs f64 noise.
    expect(queriesOf({ kind: 'edge', where: { center: { point: [5, 0, 1e-9], radius: 0 } } }, edges()))
      .toEqual(['q_near'])
  })

  it('matches an arc by its conic centre, not the point at mid-sweep', () => {
    // pointOf reads the underlying conic's centre for an arc, exactly as the
    // geometry summary reports it. The point on the curve at mid-sweep is a
    // different point and must not match.
    const arc: EdgeData = {
      kind: 'arc', center: [0, 0, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0],
      angle_start: 0, angle_end: Math.PI / 2,
    }
    const bodies = { body_ex1: bodyResult('body_ex1', [arc], ['q_arc']) }
    expect(queriesOf({ kind: 'edge', where: { center: { point: [0, 0, 0] } } }, bodies))
      .toEqual(['q_arc'])
    const midSweep: V3 = [5 / Math.SQRT2, 5 / Math.SQRT2, 0]
    expect(() => queriesOf({ kind: 'edge', where: { center: { point: midSweep } } }, bodies))
      .toThrow(SelectorError)
  })

  it('an empty match names the center clause like every other predicate', () => {
    expect(() => selectByPredicate({ kind: 'edge', where: { center: { point: [100, 0, 0] } } }, edges()))
      .toThrow(/center .* matched 0/)
  })

  it('treats a missing point from an unvalidated mate ref as a clean non-match', () => {
    // assemblyRefs.ts reaches the engine without validateSelector: a bad point
    // must be an empty match with diagnostics, not a raw TypeError.
    let error: unknown
    try {
      selectByPredicate({ kind: 'edge', where: { center: {} as never } }, edges())
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(SelectorError)
    expect((error as Error).message).toContain('center {} matched 0')
  })

  it('a face selector matches by its centroid, following within and extreme', () => {
    const faces: FaceData[] = [
      { centroid: [5, 5, 10], normal: [0, 0, 1], surface_type: 'flatface' },
      { centroid: [5, 5, 0], normal: [0, 0, -1], surface_type: 'flatface' },
    ]
    const bodies = { body_ex1: bodyResult('body_ex1', [], [], faces, ['f_top', 'f_bottom']) }
    expect(queriesOf({ kind: 'face', where: { center: { point: [5, 5, 10] } } }, bodies))
      .toEqual(['f_top'])
  })

  it('composes with and, so a centre plus a kind narrows one edge', () => {
    expect(queriesOf({
      kind: 'edge',
      where: { and: [{ center: { point: [5, 0, 5] } }, { parallel: [1, 0, 0] }] },
    }, edges())).toEqual(['q_far'])
  })
})

describe('validateSelector: center', () => {
  it('accepts a point with and without a radius, including the origin', () => {
    expect(validateSelector({ kind: 'edge', where: { center: { point: [0, 0, 0] } } }))
      .toMatchObject({ where: { center: { point: [0, 0, 0] } } })
    expect(validateSelector({ kind: 'edge', where: { center: { point: [1, 2, 3], radius: 0.5 } } }))
      .toMatchObject({ where: { center: { point: [1, 2, 3], radius: 0.5 } } })
  })

  it('refuses a missing or malformed point, a negative radius and an unknown key', () => {
    expect(() => validateSelector({ kind: 'edge', where: { center: { radius: 1 } } }))
      .toThrow(/center.point is required/)
    expect(() => validateSelector({ kind: 'edge', where: { center: { point: [1, 2] } } }))
      .toThrow(/point must be three finite numbers/)
    expect(() => validateSelector({ kind: 'edge', where: { center: { point: [1, 2, 3], radius: -1 } } }))
      .toThrow(/radius must be a non-negative finite number/)
    expect(() => validateSelector({ kind: 'edge', where: { center: { point: [1, 2, 3], near: 1 } } }))
      .toThrow(/center has unknown key "near"/)
  })

  it('refuses the empty string spelling of a radius', () => {
    expect(() => validateSelector({ kind: 'edge', where: { center: { point: [1, 2, 3], radius: '1' } } }))
      .toThrow(/radius must be a non-negative finite number/)
  })
})
