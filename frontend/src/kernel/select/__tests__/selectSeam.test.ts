// Unit tests for keeping seam edges out of the direction predicates. A seam is
// an edge a face meets twice (a full cylinder's lateral seam), so the face
// boundary lists carry it once while every ordinary edge is shared by two
// faces. Pure TS over synthetic solve results.

import { describe, it, expect } from 'vitest'
import { selectByPredicate, SelectorError } from '@/kernel/select'
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

const CYLINDER = { centroid: [0, 0, 5], normal: [-1, 0, 0], surface_type: 'cylinderface' } as FaceData
const CAP_BOTTOM = { centroid: [0, 0, 0], normal: [0, 0, -1], surface_type: 'flatface' } as FaceData
const CAP_TOP = { centroid: [0, 0, 10], normal: [0, 0, 1], surface_type: 'flatface' } as FaceData
const WALL_A = { centroid: [-8, 0, 5], normal: [-1, 0, 0], surface_type: 'flatface' } as FaceData
const WALL_B = { centroid: [-9, 0, 5], normal: [1, 0, 0], surface_type: 'flatface' } as FaceData

// One cylinder plus one ordinary straight edge shared by two flat walls. The
// cylinder's seam and the ordinary line both run parallel to Z, so the direction
// test alone would return both; the face boundary lists tell them apart.
function cylinder(): Record<string, BodyResult> {
  return {
    body_ex1: bodyResult(
      'body_ex1',
      [
        line([5, 0, 0], [5, 0, 10]),
        circle([0, 0, 0], 5, [0, 0, 1]),
        circle([0, 0, 10], 5, [0, 0, 1]),
        line([-8, 0, 0], [-8, 0, 10]),
      ],
      ['q_seam', 'q_bottom', 'q_top', 'q_wall'],
      [CYLINDER, CAP_BOTTOM, CAP_TOP, WALL_A, WALL_B],
      ['f_cyl', 'f_bottom', 'f_top', 'f_wall_a', 'f_wall_b'],
      [
        ['q_seam', 'q_bottom', 'q_top'],
        ['q_bottom'],
        ['q_top'],
        ['q_wall', 'q_bottom', 'q_top'],
        ['q_wall', 'q_bottom', 'q_top'],
      ],
    ),
  }
}

// A cylinder with no ordinary edge: the seam is the only Z-parallel line.
function bareCylinder(): Record<string, BodyResult> {
  const bodies = cylinder()
  const body = bodies.body_ex1
  body.edges!.pop()
  body.edge_queries!.pop()
  body.mesh!.face_data!.pop()
  body.mesh!.face_queries!.pop()
  body.mesh!.face_edge_queries!.pop()
  body.mesh!.face_edge_queries![3] = ['q_bottom', 'q_top']
  return bodies
}

function queriesOf(selector: Selector, bodies: Record<string, BodyResult>): string[] {
  return selectByPredicate(selector, bodies).queries
}

describe('selectByPredicate: seam exclusion', () => {
  it('parallel drops the cylinder seam and keeps the ordinary line', () => {
    // Before the exclusion both straight Z edges matched: the seam and q_wall.
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, cylinder()))
      .toEqual(['q_wall'])
  })

  it('perpendicular drops the seam through the same shared direction test', () => {
    // The seam runs along Z, so it would match "perpendicular to X" too.
    expect(queriesOf({ kind: 'edge', where: { perpendicular: [1, 0, 0] } }, cylinder()))
      .toEqual(['q_wall'])
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

  it('incomplete face boundaries do not turn an ordinary edge into a seam', () => {
    // The synthetic box in select.test.ts carries only two face boundary lists.
    // An edge seen once is only a seam when every face reported its boundary;
    // otherwise the missing neighbour would make a normal edge look like one.
    const bodies = {
      body_ex1: bodyResult(
        'body_ex1',
        [line([0, 0, 0], [0, 0, 10])],
        ['q_only'],
        [CAP_BOTTOM, CAP_TOP],
        ['f_bottom', 'f_top'],
        [['q_only'], []],
      ),
    }
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, bodies)).toEqual(['q_only'])
  })

  it('a body without face boundaries keeps the older reading', () => {
    const bodies = {
      body_ex1: bodyResult('body_ex1', [line([0, 0, 0], [0, 0, 10])], ['q_only'], [], [], []),
    }
    expect(queriesOf({ kind: 'edge', where: { parallel: [0, 0, 1] } }, bodies)).toEqual(['q_only'])
  })
})
