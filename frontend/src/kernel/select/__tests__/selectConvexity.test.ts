// Unit tests for the `convexity` predicate and the class the solve publishes on
// an edge. Pure TS over a synthetic BodyResult, so the grammar and the
// discovery field are pinned without WASM. The real analyser's values are
// pinned in occ/__tests__/tessellationReal.test.ts.

import { describe, it, expect } from 'vitest'
import { selectByPredicate, validateSelector, SelectorError } from '@/kernel/select'
import type { Selector } from '@/kernel/select'
import { edgeCandidates, faceCandidates, geometryOf, vertexCandidates } from '../geometry'
import type { BodyResult, EdgeData, EdgeKind, FaceData } from '@/types/cad'

type V3 = [number, number, number]

function line(a: V3, b: V3): EdgeData {
  return { kind: 'line', start: a, end: b }
}

function lineOf(a: V3, b: V3, convexity: EdgeKind): EdgeData {
  return { ...line(a, b), convexity }
}

// One edge per class, plus an older-style edge that carries no class at all.
// q_seam is the seam in the face seam list and is also `other`: the analyser
// has no second face to take a dihedral angle from at a seam, so it leaves the
// edge unclassified. The real cylinder/cone pin lives in tessellationReal.
const EDGES: EdgeData[] = [
  lineOf([0, 0, 0], [1, 0, 0], 'convex'),
  lineOf([0, 1, 0], [1, 1, 0], 'concave'),
  lineOf([0, 2, 0], [1, 2, 0], 'tangent'),
  lineOf([0, 3, 0], [1, 3, 0], 'other'),
  lineOf([0, 4, 0], [1, 4, 0], 'other'),
  line([0, 5, 0], [1, 5, 0]),
]

const QUERIES = ['q_convex', 'q_concave', 'q_tangent', 'q_other', 'q_seam', 'q_missing']

const FACE: FaceData = { centroid: [0, 0, 0], normal: [0, 0, 1], surface_type: 'flatface' }

function body(): Record<string, BodyResult> {
  return {
    body_ex1: {
      id: 'body_ex1',
      created_by: 'ex1',
      modified_by: [],
      edges: EDGES,
      edge_queries: QUERIES,
      vertices: [[0, 0, 0]],
      vertex_queries: ['q_vertex'],
      mesh: {
        vertices: [],
        faces: [],
        face_data: [FACE],
        face_queries: ['q_face'],
        face_edge_queries: [[...QUERIES]],
        // The seam edge is named in this face's seam list.
        face_seam_queries: [['q_seam']],
      },
    },
  }
}

function queriesOf(selector: Selector, bodies = body()): string[] {
  return selectByPredicate(selector, bodies).queries
}

describe('selectByPredicate: convexity', () => {
  it('each class returns exactly the edges that carry it', () => {
    const expected: Record<EdgeKind, string[]> = {
      convex: ['q_convex'],
      concave: ['q_concave'],
      tangent: ['q_tangent'],
      other: ['q_other', 'q_seam'],
    }
    for (const kind of Object.keys(expected) as EdgeKind[]) {
      expect(queriesOf({ kind: 'edge', where: { convexity: kind } }), kind).toEqual(expected[kind])
    }
  })

  it('a seam is unclassified by the analyse, so it reports other, not tangent', () => {
    // Measured on a real cylinder and cone: a seam has one face on both sides,
    // so BRepOffset_Analyse has no dihedral angle and leaves it `other`. The
    // seam leaf is the direct way to name it; `{convexity: "tangent"}` must not
    // quietly include seams.
    const bodies = body()
    expect(queriesOf({ kind: 'edge', where: { convexity: 'tangent' } }, bodies))
      .not.toContain('q_seam')
    expect(queriesOf({ kind: 'edge', where: { convexity: 'other' } }, bodies))
      .toContain('q_seam')
    // The seam is still exactly the seam leaf's match.
    expect(queriesOf({ kind: 'edge', where: { seam: true } }, bodies)).toEqual(['q_seam'])
  })

  it('an edge with no published class matches no value, never "other"', () => {
    // An older result, the metadata pass, or a body the analyse refused leaves
    // the field absent. It must not fall into the analyser's catch-all class.
    for (const kind of ['convex', 'concave', 'tangent', 'other'] as EdgeKind[]) {
      expect(queriesOf({ kind: 'edge', where: { convexity: kind } })).not.toContain('q_missing')
    }
    expect(queriesOf({ kind: 'edge', where: { not: { convexity: 'other' } } })).toContain('q_missing')
  })

  it('a face or vertex has no class and matches none, and the error names the clause', () => {
    expect(() => queriesOf({ kind: 'face', where: { convexity: 'convex' } }))
      .toThrow(SelectorError)
    try {
      queriesOf({ kind: 'face', where: { convexity: 'convex' } })
    } catch (e) {
      expect((e as Error).message).toContain('convexity "convex" matched 0')
    }
    expect(() => queriesOf({ kind: 'vertex', where: { convexity: 'convex' } }))
      .toThrow(/convexity "convex" matched 0/)
  })

  it('composes with the other leaves', () => {
    expect(queriesOf({
      kind: 'edge',
      where: { and: [{ convexity: 'concave' }, { parallel: [1, 0, 0] }] },
    })).toEqual(['q_concave'])
    expect(queriesOf({
      kind: 'edge',
      where: { and: [{ convexity: 'tangent' }, { seam: false }] },
    })).toEqual(['q_tangent'])
    expect(() => queriesOf({
      kind: 'edge',
      where: { and: [{ convexity: 'tangent' }, { seam: true }] },
    })).toThrow(/then seam true left 0 of 1/)
  })
})

describe('selectByPredicate: item geometry carries the class and the seam flag', () => {
  it('reports convexity and seam on an edge item', () => {
    const candidate = edgeCandidates(body())[0]
    const geometry = geometryOf(candidate)
    expect(geometry).toMatchObject({ kind: 'line', convexity: 'convex', seam: false })
  })

  it('reports seam true on the seam edge and omits convexity when absent', () => {
    const bodies = body()
    const missing = edgeCandidates(bodies)[5]
    expect(geometryOf(missing)).toMatchObject({ seam: false })
    expect(geometryOf(missing)).not.toHaveProperty('convexity')
    const seam = selectByPredicate({ kind: 'edge', where: { seam: true } }, bodies).items[0]
    expect(seam.geometry).toMatchObject({ convexity: 'other', seam: true })
  })

  it('omits both fields on a face and a vertex item', () => {
    const bodies = body()
    const face = geometryOf(faceCandidates(bodies)[0])
    const vertex = geometryOf(vertexCandidates(bodies)[0])
    for (const geometry of [face, vertex]) {
      expect(geometry).not.toHaveProperty('convexity')
      expect(geometry).not.toHaveProperty('seam')
    }
  })
})

describe('validateSelector: convexity', () => {
  it('accepts the four documented classes', () => {
    for (const convexity of ['convex', 'concave', 'tangent', 'other'] as const) {
      expect(validateSelector({ kind: 'edge', where: { convexity } }))
        .toMatchObject({ where: { convexity } })
    }
  })

  it('refuses an unknown member, a wrong case and a non-string', () => {
    expect(() => validateSelector({ kind: 'edge', where: { convexity: 'convexx' } }))
      .toThrow(/convexity must be "convex", "concave", "tangent" or "other"/)
    expect(() => validateSelector({ kind: 'edge', where: { convexity: 'CONVEX' } }))
      .toThrow(/convexity must be/)
    expect(() => validateSelector({ kind: 'edge', where: { convexity: true } }))
      .toThrow(/convexity must be/)
  })

  it('refuses a misspelled key by name', () => {
    expect(() => validateSelector({ kind: 'edge', where: { convexityy: 'convex' } }))
      .toThrow(/unknown predicate "convexityy"/)
  })
})
