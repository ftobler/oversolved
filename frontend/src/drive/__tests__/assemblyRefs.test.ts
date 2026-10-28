// Drive mate refs: a part-local pick (query or selector) becomes the stored
// {part, anchor, anchor_descriptor} triple, and the assembly frame resolves
// only its four built-ins (D4). Queries are compared, never parsed.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, BodyResult, EdgeData, FaceData } from '@/types/cad'
import type { Anchor, PartBundle } from '@/kernel/partBundle'
import { ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'
import { appendPartInstance } from '@/utils/assemblyMutations'
import { buildPartAnchorIndex, resolveDriveRef, type PartAnchorIndex } from '../assemblyRefs'

function doc(): AssemblyDoc {
  const withLeft = appendPartInstance({ kind: 'assembly', features: [] }, 'rail_400', 0, { handle: 'left' })
  return appendPartInstance(withLeft, 'panel', 0, { handle: 'panel' })
}

function planeAnchor(hash: string): Anchor {
  return { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: hash, created_by: 'ex1' }
}

const A_FACE = planeAnchor('@u|face_a')
const A_EDGE: Anchor = { kind: 'line', point: [0, 0, 5], axis: [0, 0, 1], geom_hash: '@u|edge_a', created_by: 'ex1' }

function face(centroid: [number, number, number], normal: [number, number, number]): FaceData {
  return { centroid, normal, surface_type: 'flatface' }
}

const EDGE: EdgeData = { kind: 'line', start: [0, 0, 0], end: [0, 0, 10] }

const BODY: BodyResult = {
  id: 'body_ex1',
  created_by: 'ex1',
  modified_by: [],
  edges: [EDGE],
  edge_queries: ['q_edge'],
  mesh: {
    vertices: [],
    faces: [],
    face_data: [face([0, 0, 0], [0, 0, 1]), face([0, 0, 10], [0, 0, 1])],
    face_queries: ['q_face', 'q_face_b'],
    face_edge_queries: [[], []],
  },
}

function index(): PartAnchorIndex {
  return {
    anchors: { a_face: A_FACE, a_edge: A_EDGE },
    byQuery: new Map([
      ['q_face', ['a_face']],
      ['q_face_b', ['a_face']],
      ['q_edge', ['a_edge']],
      ['q_free', []],
    ]),
    bodies: { body_ex1: BODY },
  }
}

const indexFor = () => index()

describe('resolveDriveRef', () => {
  it('resolves a query hit and stamps the anchor descriptor', () => {
    const resolved = resolveDriveRef({ part: 'left', query: 'q_face' }, doc(), indexFor)
    expect(resolved).toEqual({
      ok: true,
      ref: {
        part: 'left',
        anchor: 'a_face',
        anchor_descriptor: { geom_hash: '@u|face_a', kind: 'plane', created_by: 'ex1', point: [0, 0, 0] },
      },
    })
  })

  it('refuses an entity that has no matable anchor', () => {
    const resolved = resolveDriveRef({ part: 'left', query: 'q_free' }, doc(), indexFor)
    expect(resolved).toMatchObject({ ok: false, code: 'unresolved-ref' })
    expect(!resolved.ok && resolved.message).toContain('no matable anchor')
  })

  it('refuses an unknown query by pointing at select', () => {
    const resolved = resolveDriveRef({ part: 'left', query: 'q_nope' }, doc(), indexFor)
    expect(resolved).toMatchObject({ ok: false, code: 'unresolved-ref' })
    expect(!resolved.ok && resolved.message).toContain('run select')
    expect(!resolved.ok && resolved.message).toContain('rail_400')
  })

  it('refuses a selector that matches more than one entity, naming the count', () => {
    const resolved = resolveDriveRef({ part: 'left', selector: { kind: 'face' } }, doc(), indexFor)
    expect(resolved).toMatchObject({ ok: false, code: 'unresolved-ref' })
    expect(!resolved.ok && resolved.message).toContain('matched 2 entities')
  })

  it('resolves a selector that names exactly one entity', () => {
    const resolved = resolveDriveRef({ part: 'left', selector: { kind: 'edge' } }, doc(), indexFor)
    expect(resolved).toMatchObject({ ok: true, ref: { part: 'left', anchor: 'a_edge' } })
  })

  it('resolves an assembly built-in with no descriptor', () => {
    const resolved = resolveDriveRef({ part: ASSEMBLY_HANDLE, anchor: 'AssemblyTop' }, doc(), indexFor)
    expect(resolved).toEqual({ ok: true, ref: { part: ASSEMBLY_HANDLE, anchor: 'AssemblyTop' } })
  })

  it('refuses a query on the assembly frame, listing the four built-ins', () => {
    const resolved = resolveDriveRef({ part: ASSEMBLY_HANDLE, query: 'q' }, doc(), indexFor)
    expect(resolved).toMatchObject({ ok: false, code: 'unresolved-ref' })
    for (const name of ['AssemblyOrigin', 'AssemblyTop', 'AssemblyFront', 'AssemblyRight']) {
      expect(!resolved.ok && resolved.message).toContain(name)
    }
  })

  it('refuses an unknown instance handle, listing the handles', () => {
    const resolved = resolveDriveRef({ part: 'ghost', query: 'q_face' }, doc(), indexFor)
    expect(resolved).toMatchObject({ ok: false, code: 'unknown-target' })
    expect(!resolved.ok && resolved.message).toContain('left, panel')
  })

  it('refuses a query when the part build failed', () => {
    const resolved = resolveDriveRef(
      { part: 'left', query: 'q_face' },
      doc(),
      () => new Error('bundle build failed'),
    )
    expect(resolved).toMatchObject({ ok: false, code: 'unresolved-ref' })
    expect(!resolved.ok && resolved.message).toContain('bundle build failed')
  })
})

describe('buildPartAnchorIndex', () => {
  it('never mints a phantom query for an entity slot the response did not name', () => {
    const bundle: PartBundle = {
      doc_id: 'rail_400',
      content_hash: 'h',
      schema: 1,
      bodies: [{
        mesh: { vertices: new Float32Array(0), indices: new Uint32Array(0), faceIdsPerTriangle: new Uint32Array(0) },
        edges: [],
        // Three face slots, one edge slot, one vertex slot; the response names
        // only two faces, so the third slot has no query to key on.
        entityAnchors: { faces: [['a_face'], [], ['a_face_late']], edges: [['a_edge']], vertices: [['a_vert']] },
      }],
      anchors: { a_face: A_FACE, a_edge: A_EDGE, a_vert: planeAnchor('@u|v') },
    }
    const built = buildPartAnchorIndex(bundle, { body_ex1: BODY })
    expect(built.byQuery.get('q_face')).toEqual(['a_face'])
    expect(built.byQuery.get('q_edge')).toEqual(['a_edge'])
    // The second face slot's own query is present and records its empty anchor
    // list; the unnamed third slot mints no key at all.
    expect(built.byQuery.get('q_face_b')).toEqual([])
    expect(built.byQuery.size).toBe(3)
    expect([...built.byQuery.keys()].some(key => key === undefined || key === '')).toBe(false)
    expect(built.anchors.a_vert).toBeDefined()
  })

  it('records an entity with no anchor as an empty list', () => {
    const bundle: PartBundle = {
      doc_id: 'rail_400',
      content_hash: 'h',
      schema: 1,
      bodies: [{
        mesh: { vertices: new Float32Array(0), indices: new Uint32Array(0), faceIdsPerTriangle: new Uint32Array(0) },
        edges: [],
        entityAnchors: { faces: [[], []], edges: [], vertices: [] },
      }],
      anchors: {},
    }
    const built = buildPartAnchorIndex(bundle, { body_ex1: BODY })
    expect(built.byQuery.get('q_face')).toEqual([])
  })
})
