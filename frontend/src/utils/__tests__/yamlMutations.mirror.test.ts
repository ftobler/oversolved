import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddMirror,
  applySetMirrorField,
} from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'

const mirror0 = (doc: PartDoc) => featureAt(doc, 0, 'mirror').mirror

const baseDoc: PartDoc = { features: [] }

const makeDoc = (): PartDoc => structuredClone(baseDoc)

describe('Mirror mutations', () => {
  describe('applyAddMirror', () => {
    it('inserts a feature with correct defaults', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      expect(doc.features).toHaveLength(1)
      expect(doc.features![0]).toMatchObject({
        id: 'mir1',
        kind: 'mirror',
        label: 'Mirror',
        mirror: {
          body: '',
          plane: '',
          keep_original: true,
          merge: true,
        },
      })
    })

    it('uses custom label when provided', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1', 'My Mirror')
      expect(doc.features![0].label).toBe('My Mirror')
    })
  })

  describe('applySetMirrorField', () => {
    it('updates body field', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      applySetMirrorField(doc, 'mir1', 'body', '@extrude1')
      expect(mirror0(doc).body).toBe('@extrude1')
    })

    it('updates plane field', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      applySetMirrorField(doc, 'mir1', 'plane', '@builtin_plane_front')
      expect(mirror0(doc).plane).toBe('@builtin_plane_front')
    })

    it('updates keep_original field', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      applySetMirrorField(doc, 'mir1', 'keep_original', false)
      expect(mirror0(doc).keep_original).toBe(false)
    })

    it('updates merge field', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      applySetMirrorField(doc, 'mir1', 'merge', false)
      expect(mirror0(doc).merge).toBe(false)
    })

    it('does nothing when feature is missing', () => {
      const doc = makeDoc()
      applySetMirrorField(doc, 'missing', 'body', '@extrude1')
      expect(doc.features).toHaveLength(0)
    })

    it('clearing a field with undefined deletes the key rather than storing null', () => {
      const doc = makeDoc()
      applyAddMirror(doc, 'mir1')
      applySetMirrorField(doc, 'mir1', 'plane', '@builtin_plane_front')
      applySetMirrorField(doc, 'mir1', 'plane', undefined)
      expect('plane' in mirror0(doc)).toBe(false)
    })
  })
})
