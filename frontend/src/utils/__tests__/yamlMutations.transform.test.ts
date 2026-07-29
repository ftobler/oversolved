import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddTransform,
  applyAddTransformBody,
  applyRemoveTransformBody,
  applySetTransformField,
} from '@/utils/yamlMutations'

const baseDoc: PartDoc = { features: [] }

const makeDoc = (): PartDoc => structuredClone(baseDoc)

describe('Transform mutations', () => {
  describe('applyAddTransform', () => {
    it('inserts a feature with correct defaults', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      expect(doc.features).toHaveLength(1)
      expect(doc.features![0]).toMatchObject({
        id: 'xf1',
        kind: 'transform',
        label: 'Transform',
        transform: {
          bodies: [],
          operation: 'new',
          translation: [0, 0, 0],
          rotation_angle: 0,
          scale: 1,
        },
      })
    })

    it('uses custom label when provided', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1', 'My Transform')
      expect(doc.features![0].label).toBe('My Transform')
    })
  })

  describe('applyAddTransformBody / applyRemoveTransformBody', () => {
    it('appends picks in order', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      applyAddTransformBody(doc, 'xf1', '@body_ex1')
      applyAddTransformBody(doc, 'xf1', '@body_ex2')
      expect(doc.features![0].transform!.bodies).toEqual(['@body_ex1', '@body_ex2'])
    })

    it('re-picking the same body removes it', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      applyAddTransformBody(doc, 'xf1', '@body_ex1')
      applyAddTransformBody(doc, 'xf1', '@body_ex2')
      applyAddTransformBody(doc, 'xf1', '@body_ex1')
      expect(doc.features![0].transform!.bodies).toEqual(['@body_ex2'])
    })

    it('removes by index', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      applyAddTransformBody(doc, 'xf1', '@body_ex1')
      applyAddTransformBody(doc, 'xf1', '@body_ex2')
      applyRemoveTransformBody(doc, 'xf1', 0)
      expect(doc.features![0].transform!.bodies).toEqual(['@body_ex2'])
    })

    it('does nothing when the feature is missing', () => {
      const doc = makeDoc()
      applyAddTransformBody(doc, 'missing', '@body_ex1')
      applyRemoveTransformBody(doc, 'missing', 0)
      expect(doc.features).toHaveLength(0)
    })
  })

  describe('applySetTransformField', () => {
    it('updates operation field', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      applySetTransformField(doc, 'xf1', 'operation', 'replace')
      expect(doc.features![0].transform!.operation).toBe('replace')
    })

    it('updates translation field', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      applySetTransformField(doc, 'xf1', 'translation', [10, 20, 30])
      expect(doc.features![0].transform!.translation).toEqual([10, 20, 30])
    })

    it('updates rotation_angle field', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      applySetTransformField(doc, 'xf1', 'rotation_angle', 45)
      expect(doc.features![0].transform!.rotation_angle).toBe(45)
    })

    it('updates rotation_axis field', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      applySetTransformField(doc, 'xf1', 'rotation_axis', '@sk1/axisLine')
      expect(doc.features![0].transform!.rotation_axis).toBe('@sk1/axisLine')
    })

    it('updates scale field', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      applySetTransformField(doc, 'xf1', 'scale', 2.5)
      expect(doc.features![0].transform!.scale).toBe(2.5)
    })

    it('updates scale_center_from field', () => {
      const doc = makeDoc()
      applyAddTransform(doc, 'xf1')
      applySetTransformField(doc, 'xf1', 'scale_center_from', '@sk1/pt1xy')
      expect(doc.features![0].transform!.scale_center_from).toBe('@sk1/pt1xy')
    })

    it('does nothing when feature is missing', () => {
      const doc = makeDoc()
      applySetTransformField(doc, 'missing', 'operation', 'replace')
      expect(doc.features).toHaveLength(0)
    })
  })
})
