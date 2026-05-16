import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddArray,
  applySetArrayField,
} from '@/utils/yamlMutations'

const baseDoc: PartDoc = { features: [] }

const makeDoc = (): PartDoc => structuredClone(baseDoc)

describe('Array mutations', () => {
  describe('applyAddArray', () => {
    it('inserts a feature with correct defaults', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      expect(doc.features).toHaveLength(1)
      expect(doc.features![0]).toMatchObject({
        id: 'arr1',
        kind: 'array',
        label: 'Array',
        array: {
          mode: 'linear',
          count_x: 2,
          pitch_x: 20,
          direction_x: [1, 0, 0],
          operation: 'add',
          include_source: true,
        },
      })
    })

    it('uses custom label when provided', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1', 'My Array')
      expect(doc.features![0].label).toBe('My Array')
    })
  })

  describe('applySetArrayMode', () => {
    it('sets mode to rectangular and adds Y defaults', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rectangular')
      expect(doc.features![0].array!.mode).toBe('rectangular')
      expect(doc.features![0].array!.count_y).toBe(2)
      expect(doc.features![0].array!.pitch_y).toBe(20)
    })

    it('sets mode to rotational and removes X/Y fields', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rotational')
      expect(doc.features![0].array!.mode).toBe('rotational')
      expect(doc.features![0].array!.count).toBe(4)
      expect(doc.features![0].array!.count_x).toBeUndefined()
    })

    it('sets mode to linear and clears rotational fields', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rectangular')
      applySetArrayField(doc, 'arr1', 'mode', 'rotational')
      applySetArrayField(doc, 'arr1', 'mode', 'linear')
      expect(doc.features![0].array!.mode).toBe('linear')
      expect(doc.features![0].array!.count_y).toBeUndefined()
      expect(doc.features![0].array!.count).toBeUndefined()
    })
  })

  describe('applySetArraySourceBody', () => {
    it('updates source_body field', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'source_body', 'extrude1')
      expect(doc.features![0].array!.source_body).toBe('extrude1')
    })
  })

  describe('applySetArrayOperation', () => {
    it('updates operation field', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'operation', 'new')
      expect(doc.features![0].array!.operation).toBe('new')
    })
  })

  describe('applySetArrayIncludeSource', () => {
    it('updates include_source field', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'include_source', false)
      expect(doc.features![0].array!.include_source).toBe(false)
    })
  })

  describe('applySetArrayCountX', () => {
    it('updates count_x field', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'count_x', 5)
      expect(doc.features![0].array!.count_x).toBe(5)
    })
  })

  describe('applySetArrayPitchX', () => {
    it('updates pitch_x field', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'pitch_x', 30.5)
      expect(doc.features![0].array!.pitch_x).toBe(30.5)
    })
  })

  describe('applySetArrayCountY', () => {
    it('updates count_y field', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rectangular')
      applySetArrayField(doc, 'arr1', 'count_y', 4)
      expect(doc.features![0].array!.count_y).toBe(4)
    })
  })

  describe('applySetArrayPitchY', () => {
    it('updates pitch_y field', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rectangular')
      applySetArrayField(doc, 'arr1', 'pitch_y', 15.0)
      expect(doc.features![0].array!.pitch_y).toBe(15.0)
    })
  })

  describe('applySetArrayCount', () => {
    it('updates count field for rotational mode', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rotational')
      applySetArrayField(doc, 'arr1', 'count', 8)
      expect(doc.features![0].array!.count).toBe(8)
    })
  })

  describe('applySetArrayStepAngle', () => {
    it('updates step_angle field to a value', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rotational')
      applySetArrayField(doc, 'arr1', 'step_angle', 45.0)
      expect(doc.features![0].array!.step_angle).toBe(45.0)
    })

    it('updates step_angle field to null for evenly spaced', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rotational')
      applySetArrayField(doc, 'arr1', 'step_angle', null)
      expect(doc.features![0].array!).not.toHaveProperty('step_angle')
    })
  })

  describe('applySetArrayAxis', () => {
    it('updates axis query field', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rotational')
      applySetArrayField(doc, 'arr1', 'axis', '@sk1/axisLine')
      expect(doc.features![0].array!.axis).toBe('@sk1/axisLine')
    })
  })
})