// Unit tests for the `within` range predicate: the element's WHOLE bounding box
// must sit inside the world-axis range. Pure TS over synthetic solve results.
//
// The recipe it replaces was a chain of `extreme` clauses, which can only name
// the min or the max group, never "the edges between z=10 and z=20".

import { describe, it, expect } from 'vitest'
import { selectByPredicate, validateSelector, SelectorError } from '@/kernel/select'
import type { Selector } from '@/kernel/select'
import type { BodyResult, EdgeData, FaceData } from '@/types/cad'

type V3 = [number, number, number]

function line(a: V3, b: V3): EdgeData {
  return { kind: 'line', start: a, end: b }
}

function bodyResult(
  id: string,
  edges: EdgeData[],
  edgeQueries: string[],
  faces: FaceData[] = [],
  faceQueries: string[] = [],
  mesh?: Pick<NonNullable<BodyResult['mesh']>, 'vertices' | 'faces' | 'triangle_to_face'>,
): BodyResult {
  return {
    id,
    created_by: 'ex1',
    modified_by: [],
    edges,
    edge_queries: edgeQueries,
    mesh: { vertices: [], faces: [], face_data: faces, face_queries: faceQueries, ...mesh },
  }
}

// A stepped block: a 10 x 10 base ring at z=0, a 6 x 6 step ring at z=10 and a
// 2 x 2 top ring at z=20, plus one vertical edge through all three levels.
function steppedBlock(): Record<string, BodyResult> {
  const edges: EdgeData[] = [
    // bottom ring
    line([0, 0, 0], [10, 0, 0]), line([10, 0, 0], [10, 10, 0]),
    line([10, 10, 0], [0, 10, 0]), line([0, 10, 0], [0, 0, 0]),
    // step ring
    line([0, 0, 10], [6, 0, 10]), line([6, 0, 10], [6, 6, 10]),
    line([6, 6, 10], [0, 6, 10]), line([0, 6, 10], [0, 0, 10]),
    // top ring
    line([0, 0, 20], [2, 0, 20]), line([2, 0, 20], [2, 2, 20]),
    line([2, 2, 20], [0, 2, 20]), line([0, 2, 20], [0, 0, 20]),
    // a long vertical edge from the bottom to the top
    line([0, 0, 0], [0, 0, 20]),
  ]
  const queries = edges.map((_, i) => `q_e${i}`)
  return { body_block: bodyResult('body_block', edges, queries) }
}

const ALL_EDGE_QUERIES = Array.from({ length: 13 }, (_, i) => `q_e${i}`)

function queriesOf(selector: Selector, bodies: Record<string, BodyResult>): string[] {
  return selectByPredicate(selector, bodies).queries
}

describe('selectByPredicate: within', () => {
  it('returns every edge whose whole bbox is in the z range', () => {
    expect(queriesOf({ kind: 'edge', where: { within: { axis: 'z', min: 10, max: 20 } } }, steppedBlock()))
      .toEqual(ALL_EDGE_QUERIES.slice(4, 12))
  })

  it('excludes an edge that crosses the boundary, even if its centre is inside', () => {
    // The vertical edge runs 0..20: its centre is at z=10, inside the range, but
    // its bbox is not. "The edges between z=10 and z=20" must not include it.
    expect(queriesOf({ kind: 'edge', where: { within: { axis: 'z', min: 10, max: 20 } } }, steppedBlock()))
      .not.toContain('q_e12')
  })

  it('open ends: min only and max only', () => {
    expect(queriesOf({ kind: 'edge', where: { within: { axis: 'z', min: 15 } } }, steppedBlock()))
      .toEqual(ALL_EDGE_QUERIES.slice(8, 12))
    expect(queriesOf({ kind: 'edge', where: { within: { axis: 'z', max: 5 } } }, steppedBlock()))
      .toEqual(ALL_EDGE_QUERIES.slice(0, 4))
  })

  it('a range that matches nothing is the usual empty-selector error', () => {
    expect(() => queriesOf({ kind: 'edge', where: { within: { axis: 'z', min: 1, max: 9 } } }, steppedBlock()))
      .toThrow(SelectorError)
    // The diagnostic names the clause, so the author copies it back.
    try {
      selectByPredicate({ kind: 'edge', where: { within: { axis: 'z', min: 1, max: 9 } } }, steppedBlock())
    } catch (e) {
      expect((e as Error).message).toContain('within {"axis":"z","min":1,"max":9} matched 0')
    }
  })

  it('tests a selected face by its mesh bbox, not its centroid', () => {
    const faces: FaceData[] = [
      { centroid: [0.5, 0.5, 0], normal: [0, 0, 1], surface_type: 'flatface' },
      { centroid: [5.5, 0.5, 0], normal: [0, 0, 1], surface_type: 'flatface' },
    ]
    const bodies = {
      body_b: bodyResult('body_b', [], [], faces, ['f0', 'f1'], {
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [5, 0, 0], [6, 0, 0], [5, 1, 0]],
        faces: [[0, 1, 2], [3, 4, 5]],
        triangle_to_face: [0, 1],
      }),
    }
    expect(queriesOf({ kind: 'face', where: { within: { axis: 'x', min: 0, max: 2 } } }, bodies))
      .toEqual(['f0'])
  })
})

describe('validateSelector: within', () => {
  it('accepts each axis letter and both open ends', () => {
    expect(validateSelector({ kind: 'edge', where: { within: { axis: 'x', min: 1 } } }))
      .toMatchObject({ where: { within: { axis: 'x', min: 1 } } })
    expect(validateSelector({ kind: 'edge', where: { within: { axis: 'z', max: 4 } } }))
      .toMatchObject({ where: { within: { axis: 'z', max: 4 } } })
  })

  it('refuses a bad axis, no bounds, a non-finite bound and a reversed range', () => {
    expect(() => validateSelector({ kind: 'edge', where: { within: { axis: 'up', min: 1 } } }))
      .toThrow(/within.axis must be "x", "y" or "z"/)
    expect(() => validateSelector({ kind: 'edge', where: { within: { axis: 'z' } } }))
      .toThrow(/needs at least one of min\/max/)
    expect(() => validateSelector({ kind: 'edge', where: { within: { axis: 'z', min: 'a' } } }))
      .toThrow(/min must be a finite number/)
    expect(() => validateSelector({ kind: 'edge', where: { within: { axis: 'z', min: 5, max: 1 } } }))
      .toThrow(/must not exceed max/)
  })

  it('rejects an unknown key inside the clause', () => {
    expect(() => validateSelector({ kind: 'edge', where: { within: { axis: 'z', near: 1 } } }))
      .toThrow(/within has unknown key "near"/)
  })
})
