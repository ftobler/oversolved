// Move-face mutations: the four apply functions, their defaults, the toggle
// and remove behaviour, and the dispatch-table wiring. Undo/redo properties for
// the four are covered by the mutation-example registry fuzz
// (hooks/__tests__/historyProperties.test.ts).
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddMoveFace,
  applySetMoveFaceField,
  applyAddMoveFaceRef,
  applyRemoveMoveFaceRef,
} from '@/utils/yamlMutations'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { featureAt } from '@/testing/featureAccess'

const sub = (doc: PartDoc) => featureAt(doc, 0, 'move_face').move_face

describe('applyAddMoveFace', () => {
  it('appends a move face with the signed defaults', () => {
    const doc: PartDoc = {}
    applyAddMoveFace(doc, 'mf1')
    expect(doc.features).toHaveLength(1)
    expect(sub(doc)).toEqual({ faces: [], distance: 5 })
    expect(doc.features![0]).toMatchObject({ id: 'mf1', kind: 'move_face', label: 'Move Face' })
  })

  it('honours a label', () => {
    const doc: PartDoc = {}
    applyAddMoveFace(doc, 'mf1', 'My Move')
    expect(doc.features![0].label).toBe('My Move')
  })
})

describe('applySetMoveFaceField', () => {
  it('writes a signed distance and clears a field on empty', () => {
    const doc: PartDoc = { features: [{ id: 'mf1', kind: 'move_face', move_face: { faces: [], distance: 5 } }] }
    applySetMoveFaceField(doc, 'mf1', 'distance', -3)
    expect(sub(doc).distance).toBe(-3)
    applySetMoveFaceField(doc, 'mf1', 'distance', '')
    expect(sub(doc)).not.toHaveProperty('distance')
  })

  it('refuses a non-finite distance', () => {
    const doc: PartDoc = { features: [{ id: 'mf1', kind: 'move_face', move_face: { faces: [], distance: 5 } }] }
    applySetMoveFaceField(doc, 'mf1', 'distance', NaN)
    expect(sub(doc).distance).toBe(5)
  })
})

describe('applyAddMoveFaceRef toggle', () => {
  it('adds a new face query and toggles an existing one off', () => {
    const doc: PartDoc = { features: [{ id: 'mf1', kind: 'move_face', move_face: { faces: ['?f1'], distance: 5 } }] }
    applyAddMoveFaceRef(doc, 'mf1', '?f2')
    expect(sub(doc).faces).toEqual(['?f1', '?f2'])
    applyAddMoveFaceRef(doc, 'mf1', '?f1')
    expect(sub(doc).faces).toEqual(['?f2'])
  })
})

describe('applyRemoveMoveFaceRef', () => {
  it('removes the ref at the index and ignores an out-of-range one', () => {
    const doc: PartDoc = { features: [{ id: 'mf1', kind: 'move_face', move_face: { faces: ['f0', 'f1', 'f2'], distance: 5 } }] }
    applyRemoveMoveFaceRef(doc, 'mf1', 1)
    expect(sub(doc).faces).toEqual(['f0', 'f2'])
    applyRemoveMoveFaceRef(doc, 'mf1', 9)
    expect(sub(doc).faces).toEqual(['f0', 'f2'])
  })
})

describe('move-face mutations through the dispatch table', () => {
  it('applies add/set/add-ref in order', () => {
    const doc: PartDoc = {}
    mutationHandlers.add_move_face(doc, { type: 'add_move_face', featureId: 'mf1', label: 'Move Face' })
    mutationHandlers.add_move_face_ref(doc, { type: 'add_move_face_ref', featureId: 'mf1', faceQuery: '?f1' })
    mutationHandlers.set_move_face_field(doc, { type: 'set_move_face_field', featureId: 'mf1', field: 'distance', value: -2 })
    expect(sub(doc)).toEqual({ faces: ['?f1'], distance: -2 })
  })
})
