import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import { applyAddPattern, applySetPatternField } from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'

const pattern0 = (doc: PartDoc) => featureAt(doc, 0, 'pattern').pattern

const makeDoc = (): PartDoc => ({ features: [] })

describe('Pattern mutations', () => {
  describe('applyAddPattern', () => {
    it('inserts a linear pattern with the documented defaults', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1')
      expect(doc.features).toHaveLength(1)
      expect(doc.features![0]).toMatchObject({
        id: 'pt1',
        kind: 'pattern',
        label: 'Pattern',
        pattern: {
          subject: 'body', mode: 'linear', operation: 'add',
          count: 2, pitch: 20,
        },
      })
    })

    it('merges inline fields like the setters, an empty value clearing a key', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1', 'Ring', {
        subject: 'feature', source_feature: '@ex1', count: 4, pitch: 8, direction: [1, 0, 0],
      })
      expect(pattern0(doc)).toEqual({
        subject: 'feature', mode: 'linear', count: 4, pitch: 8,
        source_feature: '@ex1', direction: [1, 0, 0],
      })
      applyAddPattern(doc, 'pt2', undefined, { count: 3, pitch: '' })
      expect(featureAt(doc, 1, 'pattern').pattern.pitch).toBeUndefined()
    })

    it('refuses an inline count the loader would refuse', () => {
      const doc = makeDoc()
      for (const count of [0, 1, 2.5]) {
        applyAddPattern(doc, 'pt1', undefined, { count })
        expect(doc.features).toHaveLength(0)
      }
    })
  })

  describe('applySetPatternField', () => {
    it('writes the known fields and clears on empty', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1', undefined, { subject: 'feature', source_feature: '@ex1' })
      applySetPatternField(doc, 'pt1', 'count', 5)
      applySetPatternField(doc, 'pt1', 'mode', 'circular')
      applySetPatternField(doc, 'pt1', 'step_angle', 45)
      applySetPatternField(doc, 'pt1', 'axis_direction', [0, 0, 1])
      expect(pattern0(doc)).toMatchObject({
        source_feature: '@ex1', count: 5, mode: 'circular', step_angle: 45, axis_direction: [0, 0, 1],
      })
      applySetPatternField(doc, 'pt1', 'source_feature', '')
      expect(pattern0(doc).source_feature).toBeUndefined()
    })

    it('refuses an unknown field by name and a count the loader would refuse', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1')
      applySetPatternField(doc, 'pt1', 'spacing' as never, 5)
      expect(pattern0(doc)).not.toHaveProperty('spacing')
      applySetPatternField(doc, 'pt1', 'count', 1)
      expect(pattern0(doc).count).toBe(2)
    })

    it('drops the retired include_source key on the next edit', () => {
      const legacy = { subject: 'body', mode: 'linear', operation: 'add', count: 3, include_source: false }
      const doc: PartDoc = {
        features: [{ id: 'pt1', kind: 'pattern', pattern: legacy } as unknown as PartFeature],
      }
      applySetPatternField(doc, 'pt1', 'pitch', 25)
      expect(pattern0(doc)).not.toHaveProperty('include_source')
      expect(pattern0(doc).count).toBe(3)
    })

    it('warns rather than throwing on a missing or wrong-kind feature', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1')
      applySetPatternField(doc, 'missing', 'count', 3)
      applySetPatternField(doc, 'pt1', 'count', 3)
      expect(pattern0(doc).count).toBe(3)
    })
  })
})
