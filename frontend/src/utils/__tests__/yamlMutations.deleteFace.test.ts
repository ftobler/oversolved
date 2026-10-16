import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddDeleteFace,
  applyAddDeleteFaceRef,
  applyRemoveDeleteFaceRef,
} from '@/utils/yamlMutations'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { featureAt } from '@/testing/featureAccess'

const df = (doc: PartDoc) => featureAt(doc, 0, 'delete_face').delete_face

describe('applyAddDeleteFace', () => {
  it('appends a delete_face with an empty face list', () => {
    const doc: PartDoc = {}
    applyAddDeleteFace(doc, 'df1')
    expect(doc.features).toHaveLength(1)
    expect(df(doc)).toEqual({ faces: [] })
    expect(doc.features![0]).toMatchObject({ id: 'df1', kind: 'delete_face', label: 'Delete Face' })
  })

  it('seeds the faces from a selection and honours a label', () => {
    const doc: PartDoc = {}
    applyAddDeleteFace(doc, 'df1', 'Hole Heal', ['?f1', '?f2'])
    expect(df(doc)).toEqual({ faces: ['?f1', '?f2'] })
    expect(doc.features![0].label).toBe('Hole Heal')
  })

  it('copies the seeded list so later mutation of the input does not touch the doc', () => {
    const doc: PartDoc = {}
    const faces = ['?f1']
    applyAddDeleteFace(doc, 'df1', undefined, faces)
    faces.push('?f2')
    expect(df(doc).faces).toEqual(['?f1'])
  })
})

describe('applyAddDeleteFaceRef toggle', () => {
  it('adds a new face query', () => {
    const doc: PartDoc = { features: [{ id: 'df1', kind: 'delete_face', delete_face: { faces: ['?f1'] } }] }
    applyAddDeleteFaceRef(doc, 'df1', '?f2')
    expect(df(doc).faces).toEqual(['?f1', '?f2'])
  })

  it('removes an existing face query (toggle)', () => {
    const doc: PartDoc = { features: [{ id: 'df1', kind: 'delete_face', delete_face: { faces: ['?f1', '?f2'] } }] }
    applyAddDeleteFaceRef(doc, 'df1', '?f1')
    expect(df(doc).faces).toEqual(['?f2'])
  })

  it('does nothing on a wrong kind', () => {
    const doc: PartDoc = { features: [{ id: 'df1', kind: 'sketch' }] }
    const before = structuredClone(doc)
    applyAddDeleteFaceRef(doc, 'df1', '?f1')
    expect(doc).toEqual(before)
  })
})

describe('applyRemoveDeleteFaceRef', () => {
  it('removes the face at the given index', () => {
    const doc: PartDoc = { features: [{ id: 'df1', kind: 'delete_face', delete_face: { faces: ['f0', 'f1', 'f2'] } }] }
    applyRemoveDeleteFaceRef(doc, 'df1', 1)
    expect(df(doc).faces).toEqual(['f0', 'f2'])
  })

  it('ignores an out-of-range index', () => {
    const doc: PartDoc = { features: [{ id: 'df1', kind: 'delete_face', delete_face: { faces: ['f0'] } }] }
    applyRemoveDeleteFaceRef(doc, 'df1', 5)
    expect(df(doc).faces).toEqual(['f0'])
  })
})

describe('delete_face mutations through the dispatch table', () => {
  it('applies add_delete_face and add_delete_face_ref through mutationHandlers', () => {
    const doc: PartDoc = {}
    mutationHandlers.add_delete_face(doc, { type: 'add_delete_face', featureId: 'df1', label: 'Delete Face', faces: ['?f0'] })
    mutationHandlers.add_delete_face_ref(doc, { type: 'add_delete_face_ref', featureId: 'df1', faceQuery: '?f1' })
    mutationHandlers.remove_delete_face_ref(doc, { type: 'remove_delete_face_ref', featureId: 'df1', index: 0 })
    expect(df(doc)).toEqual({ faces: ['?f1'] })
  })
})
