import { describe, it, expect, vi } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddCircularArray,
  applySetCircularArrayField,
} from '@/utils/yamlMutations'

const baseDoc: PartDoc = { features: [] }

const makeDoc = (): PartDoc => structuredClone(baseDoc)

describe('Circular Array mutations', () => {
  describe('applyAddCircularArray', () => {
    it('inserts a feature with correct defaults', () => {
      const doc = makeDoc()
      applyAddCircularArray(doc, 'ca1')
      expect(doc.features).toHaveLength(1)
      expect(doc.features![0]).toMatchObject({
        id: 'ca1',
        kind: 'circular_array',
        label: 'Circular Array',
        circular_array: {
          count: 4,
          operation: 'add',
          include_source: true,
        },
      })
    })

    it('uses custom label when provided', () => {
      const doc = makeDoc()
      applyAddCircularArray(doc, 'ca1', 'My Circular')
      expect(doc.features![0].label).toBe('My Circular')
    })
  })

  describe('applySetCircularArrayField', () => {
    it('updates count field', () => {
      const doc = makeDoc()
      applyAddCircularArray(doc, 'ca1')
      applySetCircularArrayField(doc, 'ca1', 'count', 8)
      expect(doc.features![0].circular_array!.count).toBe(8)
    })

    it('updates step_angle field to a value', () => {
      const doc = makeDoc()
      applyAddCircularArray(doc, 'ca1')
      applySetCircularArrayField(doc, 'ca1', 'step_angle', 45.0)
      expect(doc.features![0].circular_array!.step_angle).toBe(45.0)
    })

    it('updates step_angle field to null for evenly spaced', () => {
      const doc = makeDoc()
      applyAddCircularArray(doc, 'ca1')
      applySetCircularArrayField(doc, 'ca1', 'step_angle', null)
      expect(doc.features![0].circular_array!).not.toHaveProperty('step_angle')
    })

    it('updates axis query field', () => {
      const doc = makeDoc()
      applyAddCircularArray(doc, 'ca1')
      applySetCircularArrayField(doc, 'ca1', 'axis', '@sk1/axisLine')
      expect(doc.features![0].circular_array!.axis).toBe('@sk1/axisLine')
    })

    it('updates operation field', () => {
      const doc = makeDoc()
      applyAddCircularArray(doc, 'ca1')
      applySetCircularArrayField(doc, 'ca1', 'operation', 'new')
      expect(doc.features![0].circular_array!.operation).toBe('new')
    })

    it('updates include_source field', () => {
      const doc = makeDoc()
      applyAddCircularArray(doc, 'ca1')
      applySetCircularArrayField(doc, 'ca1', 'include_source', false)
      expect(doc.features![0].circular_array!.include_source).toBe(false)
    })

    it('updates source_body field', () => {
      const doc = makeDoc()
      applyAddCircularArray(doc, 'ca1')
      applySetCircularArrayField(doc, 'ca1', 'source_body', 'extrude1')
      expect(doc.features![0].circular_array!.source_body).toBe('extrude1')
    })

    it('warns when feature has no circular_array', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const doc = makeDoc()
      doc.features!.push({ id: 'other', kind: 'extrude', extrude: { sketch: [], distance: 10 } })
      applySetCircularArrayField(doc, 'other', 'count', 5)
      expect(warnSpy).toHaveBeenCalledWith('applySetCircularArrayField: feature other has no circular_array')
      expect(doc.features![0].circular_array).toBeUndefined()
      warnSpy.mockRestore()
    })
  })
})
