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

    it('sets mode to linear and clears Y fields', () => {
      const doc = makeDoc()
      applyAddArray(doc, 'arr1')
      applySetArrayField(doc, 'arr1', 'mode', 'rectangular')
      applySetArrayField(doc, 'arr1', 'mode', 'linear')
      expect(doc.features![0].array!.mode).toBe('linear')
      expect(doc.features![0].array!.count_y).toBeUndefined()
    })
  })
})