// Unit tests for keeping seam edges out of the direction predicates. A seam is
// an edge a face meets twice (a full cylinder's lateral seam), which the mesh
// records in `face_seam_queries`. A free edge of an open shell is also listed by
// one face only, so it is not a seam and must stay selectable. Pure TS over
// synthetic solve results.

import { describe, it, expect } from 'vitest'
import { selectByPredicate, validateSelector, SelectorError } from '@/kernel/select'
import type { Selector } from '@/kernel/select'
import type { PartResult, EdgeData, FaceData } from '@/types/cad'

type V3 = [number, number, number]

function line(a: V3, b: V3): EdgeData {
  return { kind: 'line', start: a, end: b }
}

function circle(center: V3, radius: number, axis: V3): EdgeData {
  return { kind: 'circle', center, radius, axis, x_axis: [1, 0, 0], angle_start: 0, angle_end: 2 * Math.PI }
}

function partResult(
  id: string,
  edges: EdgeData[],
  edgeQueries: string[],
  faces: FaceData[],
  faceQueries: string[],
  faceEdgeQueries: string[][],
  faceSeamQueries?: string[][],
): PartResult {
  return {
    id,
    created_by: 'ex1',
    modified_by: [],
    edges,
    edge_queries: edgeQueries,
    mesh: {
      vertices: [],
      faces: [],
      face_data: faces,
      face_queries: faceQueries,
      face_edge_queries: faceEdgeQueries,
      ...(faceSeamQueries !== undefined && { face_seam_queries: faceSeamQueries }),
    },
  }
}

const CYLINDER = { centroid: [0, 0, 5], normal: [-1, 0, 0], surface_type: 'cylinderface' } as FaceData
const CAP_BOTTOM = { centroid: [0, 0, 0], normal: [0, 0, -1], surface_type: 'flatface' } as FaceData
const CAP_TOP = { centroid: [0, 0, 10], normal: [0, 0, 1], surface_type: 'flatface' } as FaceData
// Two triangles that share the wall line at x=-8, y=0 and diverge along Y and X.
const WALL_A = { centroid: [-8, 10 / 3, 5], normal: [-1, 0, 0], surface_type: 'flatface' } as FaceData
const WALL_B = { centroid: [-34 / 3, 0, 5], normal: [0, 1, 0], surface_type: 'flatface' } as FaceData

// One cylinder plus one ordinary straight edge shared by two flat walls. The
// cylinder's seam and the ordinary wall line both run parallel to Z, so the
// direction test alone would return both; the seam list tells them apart.
function cylinder({ seamFlag = true }: { seamFlag?: boolean } = {}): Record<string, PartResult> {
  return {
    body_ex1: partResult(
      'body_ex1',
      [
        line([5, 0, 0], [5, 0, 10]),
        circle([0, 0, 0], 5, [0, 0, 1]),
        circle([0, 0, 10], 5, [0, 0, 1]),
        line([-8, 0, 0], [-8, 0, 10]),
        line([-8, 0, 10], [-8, 10, 5]),
        line([-8, 10, 5], [-8, 0, 0]),
        line([-8, 0, 10], [-18, 0, 5]),
        line([-18, 0, 5], [-8, 0, 0]),
      ],
      ['q_seam', 'q_bottom', 'q_top', 'q_wall', 'q_wa_upper', 'q_wa_lower', 'q_wb_upper', 'q_wb_lower'],
      [CYLINDER, CAP_BOTTOM, CAP_TOP, WALL_A, WALL_B],
      ['f_cyl', 'f_bottom', 'f_top', 'f_wall_a', 'f_wall_b'],
      [
        ['q_seam', 'q_bottom', 'q_top'],
        ['q_bottom'],
        ['q_top'],
        ['q_wall', 'q_wa_upper', 'q_wa_lower'],
        ['q_wall', 'q_wb_upper', 'q_wb_lower'],
      ],
      seamFlag ? [['q_seam'], [], [], [], []] : undefined,
    ),
  }
}

// A cylinder with no ordinary line: the seam is the only Z-parallel edge.
function bareCylinder(): Record<string, PartResult> {
  const parts = cylinder()
  const part = parts.body_ex1
  part.edges!.splice(3)
  part.edge_queries!.splice(3)
  part.mesh!.face_data!.splice(3)
  part.mesh!.face_queries!.splice(3)
  part.mesh!.face_edge_queries!.splice(3)
  part.mesh!.face_seam_queries!.splice(3)
  return parts
}

// Two rectangular faces that meet at the shared Z line, with their own free
// boundary edges. A free edge is listed by one face only, exactly like a seam.
function openShell(): Record<string, PartResult> {
  return {
    body_bend: partResult(
      'body_bend',
      [
        line([-8, 0, 0], [-8, 0, 10]),
        line([-8, 10, 0], [-8, 10, 10]),
        line([-8, 0, 0], [-8, 10, 0]),
        line([-8, 0, 10], [-8, 10, 10]),
        line([-18, 0, 0], [-18, 0, 10]),
        line([-18, 0, 0], [-8, 0, 0]),
        line([-18, 0, 10], [-8, 0, 10]),
      ],
      ['q_shared', 'q_a_far', 'q_a_low', 'q_a_high', 'q_b_far', 'q_b_low', 'q_b_high'],
      [WALL_A, WALL_B],
      ['f_a', 'f_b'],
      [
        ['q_shared', 'q_a_far', 'q_a_low', 'q_a_high'],
        ['q_shared', 'q_b_far', 'q_b_low', 'q_b_high'],
      ],
      [[], []],
    ),
  }
}

function queriesOf(selector: Selector, parts: Record<string, PartResult>): string[] {
  return selectByPredicate(selector, parts).queries
}

describe('selectByPredicate: seam exclusion', () => {
  it('parallel drops the cylinder seam and keeps the ordinary wall line', () => {
    // Without the seam list both straight Z edges would match: q_seam and q_wall.
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, cylinder()))
      .toEqual(['q_wall'])
  })

  it('perpendicular drops the seam through the same shared direction test', () => {
    // Both the seam and q_wall run along Z, so they match "perpendicular to
    // [1,1,0]"; the wall triangles' diagonals do not.
    expect(queriesOf({ kind: 'edge', where: { perpendicular: [1, 1, 0] } }, cylinder()))
      .toEqual(['q_wall'])
  })

  it('the other predicates still return the seam', () => {
    const parts = cylinder()
    expect(queriesOf({ kind: 'edge', where: { type: 'line' } }, parts)).toContain('q_seam')
    expect(queriesOf({ kind: 'edge', where: { center: { point: [5, 0, 5] } } }, parts)).toContain('q_seam')
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, parts)).not.toContain('q_seam')
    expect(queriesOf({ kind: 'edge', where: { perpendicular: [1, 1, 0] } }, parts)).not.toContain('q_seam')
  })

  it('a body without the seam list still drops the seam through the count fallback', () => {
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, cylinder({ seamFlag: false })))
      .toEqual(['q_wall'])
  })

  it('a seam list shorter than the face list falls back to the count rule', () => {
    // A partial decode whose one preserved seam list belongs to the cap, not
    // the lateral face. Trusting it would keep the seam; the face list is still
    // complete, so the count fallback finds it in the second face.
    const parts = {
      body_ex1: partResult(
        'body_ex1',
        [line([0, 0, 0], [0, 0, 10]), circle([0, 0, 0], 5, [0, 0, 1])],
        ['q_seam', 'q_bottom'],
        [CAP_BOTTOM, CYLINDER],
        ['f_bottom', 'f_cyl'],
        [['q_bottom'], ['q_seam', 'q_bottom']],
        [[]],
      ),
    }
    expect(() => queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, parts))
      .toThrow(/parallel .* matched 0/)
  })

  it('a seam list longer than the face list keeps the edge', () => {
    // A truncated face list cannot be used for the count rule: the missing face
    // would make its edges look like seams, so keep them selectable instead.
    const parts = {
      body_ex1: partResult(
        'body_ex1',
        [line([0, 0, 0], [0, 0, 10]), circle([0, 0, 0], 5, [0, 0, 1])],
        ['q_seam', 'q_bottom'],
        [CAP_BOTTOM],
        ['f_bottom'],
        [['q_bottom']],
        [[], ['q_seam']],
      ),
    }
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, parts)).toEqual(['q_seam'])
  })

  it('an open shell keeps its free edges in parallel', () => {
    // q_a_far and q_b_far are listed by one face each, like a seam, but no face
    // meets them twice. The seam list is present and empty, so they stay.
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, openShell()))
      .toEqual(['q_shared', 'q_a_far', 'q_b_far'])
  })

  it('a seam-only match is the usual clean empty-selector error', () => {
    expect(() => queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, bareCylinder()))
      .toThrow(SelectorError)
    try {
      selectByPredicate({ kind: 'edge', where: { parallel: [0, 0, 1] } }, bareCylinder())
    } catch (e) {
      expect((e as Error).message).toContain('parallel [0, 0, 1] matched 0')
    }
  })

  it('the count fallback only trusts complete face boundaries', () => {
    // The synthetic box in select.test.ts carries only two face boundary lists.
    // An edge seen once is only a seam when every face reported its boundary;
    // otherwise the missing neighbour would make a normal edge look like one.
    const parts = {
      body_ex1: partResult(
        'body_ex1',
        [line([0, 0, 0], [0, 0, 10])],
        ['q_only'],
        [CAP_BOTTOM, CAP_TOP],
        ['f_bottom', 'f_top'],
        [['q_only'], []],
      ),
    }
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, parts)).toEqual(['q_only'])
  })

  it('a body without face boundaries keeps the older reading', () => {
    const parts = {
      body_ex1: partResult('body_ex1', [line([0, 0, 0], [0, 0, 10])], ['q_only'], [], [], []),
    }
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, parts)).toEqual(['q_only'])
  })
})

describe('selectByPredicate: the seam predicate', () => {
  it('{seam: true} returns the seam and {seam: false} the rest', () => {
    const parts = cylinder()
    expect(queriesOf({ kind: 'edge', where: { seam: true } }, parts)).toEqual(['q_seam'])
    const rest = ['q_bottom', 'q_top', 'q_wall', 'q_wa_upper', 'q_wa_lower', 'q_wb_upper', 'q_wb_lower']
    expect(queriesOf({ kind: 'edge', where: { seam: false } }, parts)).toEqual(rest)
  })

  it('not({seam: true}) is the same set as {seam: false}', () => {
    const parts = cylinder()
    expect(queriesOf({ kind: 'edge', where: { not: { seam: true } } }, parts))
      .toEqual(queriesOf({ kind: 'edge', where: { seam: false } }, parts))
  })

  it('a face or vertex has no seam flag and matches neither value', () => {
    const parts = cylinder()
    parts.body_ex1.vertices = [[0, 0, 0]]
    parts.body_ex1.vertex_queries = ['q_v']
    expect(() => queriesOf({ kind: 'face', where: { seam: true } }, parts))
      .toThrow(/seam true matched 0/)
    expect(() => queriesOf({ kind: 'face', where: { seam: false } }, parts))
      .toThrow(/seam false matched 0/)
    expect(() => queriesOf({ kind: 'vertex', where: { seam: true } }, parts))
      .toThrow(/seam true matched 0/)
    expect(() => queriesOf({ kind: 'vertex', where: { seam: false } }, parts))
      .toThrow(/seam false matched 0/)
  })

  it('composes with a direction clause', () => {
    // The tea_cup recipe's shape: the seam runs along the axis, so the ordinary
    // Z-parallel lines are what remain after the seam is excluded.
    expect(queriesOf({
      kind: 'edge',
      where: { and: [{ seam: false }, { parallel: [0, 0, 1] }] },
    }, cylinder())).toEqual(['q_wall'])
  })
})

describe('validateSelector: seam', () => {
  it('accepts true and false', () => {
    expect(validateSelector({ kind: 'edge', where: { seam: true } }))
      .toMatchObject({ where: { seam: true } })
    expect(validateSelector({ kind: 'edge', where: { seam: false } }))
      .toMatchObject({ where: { seam: false } })
  })

  it('refuses a string, a number and a misspelled key, with no truthy coercion', () => {
    expect(() => validateSelector({ kind: 'edge', where: { seam: 'yes' } }))
      .toThrow(/seam must be true or false/)
    expect(() => validateSelector({ kind: 'edge', where: { seam: 1 } }))
      .toThrow(/seam must be true or false/)
    expect(() => validateSelector({ kind: 'edge', where: { seamx: true } }))
      .toThrow(/unknown predicate "seamx"/)
  })
})
