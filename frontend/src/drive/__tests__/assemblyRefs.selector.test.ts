// Assembly mate selectors go through the same validateSelector as the `select`
// tool: the letter axis sugar resolves to the same face as the vector, and a
// structural typo is refused as an invalid ref instead of reaching the engine
// as a misleading empty match.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, BodyResult, FaceData } from '@/types/cad'
import type { Anchor } from '@/kernel/partBundle'
import { appendPartInstance } from '@/utils/assemblyMutations'
import { resolveDriveRef, type PartAnchorIndex } from '../assemblyRefs'

function doc(): AssemblyDoc {
  return appendPartInstance({ kind: 'assembly', features: [] }, 'block', 0, { handle: 'block' })
}

function face(centroid: [number, number, number], normal: [number, number, number]): FaceData {
  return { centroid, normal, surface_type: 'flatface' }
}

// A box centred on the origin: every axis has a clear min and max face, so the
// extreme group names exactly one.
const FACES: FaceData[] = [
  face([-5, 0, 0], [-1, 0, 0]),
  face([5, 0, 0], [1, 0, 0]),
  face([0, -5, 0], [0, -1, 0]),
  face([0, 5, 0], [0, 1, 0]),
  face([0, 0, -5], [0, 0, -1]),
  face([0, 0, 5], [0, 0, 1]),
]
const QUERIES = ['q_neg_x', 'q_pos_x', 'q_neg_y', 'q_pos_y', 'q_neg_z', 'q_pos_z']

const BODY: BodyResult = {
  id: 'body_ex1',
  created_by: 'ex1',
  modified_by: [],
  edges: [],
  mesh: {
    vertices: [],
    faces: [],
    face_data: FACES,
    face_queries: QUERIES,
    face_edge_queries: FACES.map(() => []),
  },
}

function planeAnchor(id: string, point: [number, number, number]): Anchor {
  return { kind: 'plane', point, axis: [0, 1, 0], geom_hash: `@u|${id}`, created_by: 'ex1' }
}

function index(): PartAnchorIndex {
  const anchors = Object.fromEntries(QUERIES.map((_, i) => [`a${i}`, planeAnchor(`a${i}`, FACES[i].centroid)]))
  const byQuery = new Map(QUERIES.map((query, i) => [query, [`a${i}`]]))
  return { anchors, byQuery, bodies: { body_ex1: BODY } }
}

const indexFor = () => index()

describe('resolveDriveRef: selector validation', () => {
  it('resolves the letter axis to the same face as the vector', () => {
    const letters = resolveDriveRef(
      { part: 'block', selector: { kind: 'face', where: { extreme: { axis: 'y', side: 'max' } } } },
      doc(),
      indexFor,
    )
    const vector = resolveDriveRef(
      { part: 'block', selector: { kind: 'face', where: { extreme: { axis: [0, 1, 0], side: 'max' } } } },
      doc(),
      indexFor,
    )
    expect(letters).toMatchObject({ ok: true, ref: { part: 'block', anchor: 'a3' } })
    expect(vector).toMatchObject({ ok: true, ref: { part: 'block', anchor: 'a3' } })
  })

  it('refuses a type typo with the validator wording as an invalid ref', () => {
    const resolved = resolveDriveRef(
      { part: 'block', selector: { kind: 'face', where: { type: 'plane' } } },
      doc(),
      indexFor,
    )
    expect(resolved).toMatchObject({ ok: false, code: 'invalid-ref' })
    expect(!resolved.ok && resolved.message).toContain('did you mean "flatface"')
  })

  it('refuses two side-by-side predicate keys with the and hint', () => {
    const resolved = resolveDriveRef(
      {
        part: 'block',
        selector: { kind: 'face', where: { type: 'flatface', extreme: { axis: 'y', side: 'max' } } },
      },
      doc(),
      indexFor,
    )
    expect(resolved).toMatchObject({ ok: false, code: 'invalid-ref' })
    expect(!resolved.ok && resolved.message).toContain('"and"')
  })
})
