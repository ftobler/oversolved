import { describe, it, expect, vi } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddPattern,
  applySetPatternField,
} from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'

const pattern0 = (doc: PartDoc) => featureAt(doc, 0, 'pattern').pattern

const makeDoc = (): PartDoc => ({ features: [] })

describe('Pattern mutations (circular mode)', () => {
  describe('applyAddPattern', () => {
    it('inserts a circular pattern with correct defaults', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'ca1', undefined, { mode: 'circular' })
      expect(doc.features).toHaveLength(1)
      expect(doc.features![0]).toMatchObject({
        id: 'ca1',
        kind: 'pattern',
        label: 'Pattern',
        pattern: {
          subject: 'body',
          mode: 'circular',
          count: 4,
          operation: 'add',
        },
      })
    })

    it('uses custom label when provided', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'ca1', 'My Circular', { mode: 'circular' })
      expect(doc.features![0].label).toBe('My Circular')
    })
  })

  describe('applySetPatternField', () => {
    const added = (): PartDoc => {
      const doc = makeDoc()
      applyAddPattern(doc, 'ca1', undefined, { mode: 'circular' })
      return doc
    }

    it('updates count field', () => {
      const doc = added()
      applySetPatternField(doc, 'ca1', 'count', 8)
      expect(pattern0(doc).count).toBe(8)
    })

    it('updates step_angle field to a value', () => {
      const doc = added()
      applySetPatternField(doc, 'ca1', 'step_angle', 45.0)
      expect(pattern0(doc).step_angle).toBe(45.0)
    })

    it('updates step_angle field to null for evenly spaced', () => {
      const doc = added()
      applySetPatternField(doc, 'ca1', 'step_angle', null)
      expect(pattern0(doc)).not.toHaveProperty('step_angle')
    })

    it('updates axis query field', () => {
      const doc = added()
      applySetPatternField(doc, 'ca1', 'axis', '@sk1/axisLine')
      expect(pattern0(doc).axis).toBe('@sk1/axisLine')
    })

    it('updates operation field', () => {
      const doc = added()
      applySetPatternField(doc, 'ca1', 'operation', 'new')
      expect(pattern0(doc).operation).toBe('new')
    })

    it('does not revive the retired include_source field', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const doc = added()
      applySetPatternField(doc, 'ca1', 'include_source' as never, false)
      expect(pattern0(doc)).not.toHaveProperty('include_source')
      warnSpy.mockRestore()
    })

    it('updates source_body field', () => {
      const doc = added()
      applySetPatternField(doc, 'ca1', 'source_body', 'extrude1')
      expect(pattern0(doc).source_body).toBe('extrude1')
    })

    it('warns when feature has no pattern', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const doc = makeDoc()
      doc.features!.push({ id: 'other', kind: 'extrude', extrude: { sketch: [], distance: 10 } })
      applySetPatternField(doc, 'other', 'count', 5)
      expect(warnSpy).toHaveBeenCalledWith('applySetPatternField: feature other has no pattern')
      // The wrong-kind feature keeps its own payload and gains no pattern.
      expect(doc.features![0]).not.toHaveProperty('pattern')
      warnSpy.mockRestore()
    })
  })
})
