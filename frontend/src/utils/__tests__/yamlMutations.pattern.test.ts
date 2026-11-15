import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature } from '@/types/cad'
import {
  applyAddCircularPattern, applyAddLinearPattern, applyAddPattern, applyAddPatternSource,
  applyRemovePatternSource, applyReorderPickField, applySetCircularPatternField, applySetLinearPatternField,
} from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'
import { loadPartDoc } from '@/persistence/docSchema'

const linear0 = (doc: PartDoc) => featureAt(doc, 0, 'linear_pattern').linear_pattern
const circular0 = (doc: PartDoc) => featureAt(doc, 0, 'circular_pattern').circular_pattern

const makeDoc = (): PartDoc => ({ features: [] })

describe('Pattern mutations', () => {
  describe('applyAddLinearPattern', () => {
    it('inserts a linear pattern with the documented defaults', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1')
      expect(doc.features).toHaveLength(1)
      expect(doc.features![0]).toMatchObject({
        id: 'pt1',
        kind: 'linear_pattern',
        label: 'Linear Pattern',
        linear_pattern: { subject: 'body', operation: 'add', count: 2, pitch: 20 },
      })
    })

    it('merges inline fields like the setters, an empty value clearing a key', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1', 'Ring', {
        subject: 'feature', source_features: ['@ex1', '@ex2'], count: 4, pitch: 8, direction: [1, 0, 0],
      })
      expect(linear0(doc)).toEqual({
        subject: 'feature', count: 4, pitch: 8,
        source_features: ['@ex1', '@ex2'], direction: [1, 0, 0],
      })
      applyAddLinearPattern(doc, 'pt2', undefined, { count: 3, pitch: '' })
      expect(featureAt(doc, 1, 'linear_pattern').linear_pattern).not.toHaveProperty('pitch')
    })

    it('folds the legacy single source into the list', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1', undefined, { subject: 'feature', source_feature: '@ex1' })
      expect(linear0(doc).source_features).toEqual(['@ex1'])
      expect(linear0(doc)).not.toHaveProperty('source_feature')
    })

    it('drops an unknown inline key such as the retired include_source', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1', undefined, { count: 3, include_source: false } as never)
      expect(linear0(doc).count).toBe(3)
      expect(linear0(doc)).not.toHaveProperty('include_source')
    })

    it('seeds both directions only when the second is on', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1', undefined, { second_direction: true })
      expect(linear0(doc)).toMatchObject({ count: 2, pitch: 20, count_2: 2, pitch_2: 20 })
    })

    it('refuses an inline count the loader would refuse, and accepts 1', () => {
      const doc = makeDoc()
      for (const count of [0, 2.5, '0']) {
        applyAddLinearPattern(doc, 'pt1', undefined, { count })
        expect(doc.features).toHaveLength(0)
      }
      applyAddLinearPattern(doc, 'pt1', undefined, { count: 1 })
      expect(doc.features).toHaveLength(1)
      expect(linear0(doc).count).toBe(1)
    })
  })

  describe('applyAddCircularPattern', () => {
    it('inserts a circular pattern with the documented defaults', () => {
      const doc = makeDoc()
      applyAddCircularPattern(doc, 'pt1')
      expect(doc.features![0]).toMatchObject({
        id: 'pt1',
        kind: 'circular_pattern',
        label: 'Circular Pattern',
        circular_pattern: { subject: 'body', operation: 'add', count: 4 },
      })
    })

    it('does not store the angle and equal-spacing defaults', () => {
      // An absent angle already means a full, evenly spaced turn to the kernel;
      // writing it would only be a second spelling of the same default.
      const doc = makeDoc()
      applyAddCircularPattern(doc, 'pt1')
      expect(circular0(doc)).not.toHaveProperty('angle')
      expect(circular0(doc)).not.toHaveProperty('equal_spacing')
    })

    it('refuses a grid cell in the skip list', () => {
      const doc = makeDoc()
      applyAddCircularPattern(doc, 'pt1', undefined, { skip: [[2, -1]] } as never)
      expect(doc.features).toHaveLength(0)
    })
  })

  describe('applySetLinearPatternField', () => {
    it('writes the known fields and clears on empty', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1', undefined, { subject: 'feature', source_features: ['@ex1'] })
      applySetLinearPatternField(doc, 'pt1', 'count', 5)
      applySetLinearPatternField(doc, 'pt1', 'second_direction', true)
      applySetLinearPatternField(doc, 'pt1', 'direction_2', [0, 0, 1])
      expect(linear0(doc)).toMatchObject({
        source_features: ['@ex1'], count: 5, second_direction: true, direction_2: [0, 0, 1],
      })
      // The legacy setter name writes a one-element list, and a clear empties it.
      applySetLinearPatternField(doc, 'pt1', 'source_feature', '@ex2')
      expect(linear0(doc).source_features).toEqual(['@ex2'])
      expect(linear0(doc)).not.toHaveProperty('source_feature')
      applySetLinearPatternField(doc, 'pt1', 'source_feature', '')
      expect(linear0(doc).source_features).toEqual([])
    })

    it('clears the second-direction fields when the checkbox goes off', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1', undefined, { second_direction: true })
      applySetLinearPatternField(doc, 'pt1', 'second_direction', false)
      expect(linear0(doc)).not.toHaveProperty('count_2')
      expect(linear0(doc)).not.toHaveProperty('pitch_2')
      expect(linear0(doc)).not.toHaveProperty('centered_2')
    })

    it('refuses an unknown field by name and a count the loader would refuse', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1')
      applySetLinearPatternField(doc, 'pt1', 'spacing' as never, 5)
      expect(linear0(doc)).not.toHaveProperty('spacing')
      for (const count of [0, 2.5]) {
        applySetLinearPatternField(doc, 'pt1', 'count', count)
        expect(linear0(doc).count).toBe(2)
      }
      // Count 1 is legal: it keeps only the original.
      applySetLinearPatternField(doc, 'pt1', 'count', 1)
      expect(linear0(doc).count).toBe(1)
    })

    it('stores Skip Instances as a canonical list from either spelling', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1', undefined, { count: 4 })
      applySetLinearPatternField(doc, 'pt1', 'skip', '2, 1, 2')
      expect(linear0(doc).skip).toEqual([1, 2])
      applySetLinearPatternField(doc, 'pt1', 'skip', [[2, -1], 1])
      expect(linear0(doc).skip).toEqual([1, [2, -1]])
      applySetLinearPatternField(doc, 'pt1', 'skip', '')
      expect(linear0(doc)).not.toHaveProperty('skip')
      applySetLinearPatternField(doc, 'pt1', 'skip', '0')
      expect(linear0(doc)).not.toHaveProperty('skip')
    })

    it('warns rather than throwing on a missing or wrong-kind feature', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1')
      applySetLinearPatternField(doc, 'missing', 'count', 3)
      applySetLinearPatternField(doc, 'pt1', 'count', 3)
      expect(linear0(doc).count).toBe(3)
    })
  })

  describe('applySetCircularPatternField', () => {
    it('writes the angle and the equal-spacing flag', () => {
      const doc = makeDoc()
      applyAddCircularPattern(doc, 'pt1')
      applySetCircularPatternField(doc, 'pt1', 'angle', 180)
      applySetCircularPatternField(doc, 'pt1', 'equal_spacing', false)
      expect(circular0(doc)).toMatchObject({ angle: 180, equal_spacing: false })
    })

    it('refuses a grid cell in the skip list', () => {
      const doc = makeDoc()
      applyAddCircularPattern(doc, 'pt1')
      applySetCircularPatternField(doc, 'pt1', 'skip', [[2, -1]] as never)
      expect(circular0(doc)).not.toHaveProperty('skip')
    })
  })

  describe('pattern source chips', () => {
    it('toggles a source on add and splices one off by index, for either kind', () => {
      for (const [add, read] of [
        [applyAddLinearPattern, linear0],
        [applyAddCircularPattern, circular0],
      ] as const) {
        const doc = makeDoc()
        add(doc, 'pt1', undefined, { subject: 'feature', source_features: ['@ex1'] })
        applyAddPatternSource(doc, 'pt1', '@rv1')
        expect(read(doc).source_features).toEqual(['@ex1', '@rv1'])
        applyAddPatternSource(doc, 'pt1', '@ex1')
        expect(read(doc).source_features).toEqual(['@rv1'])
        applyRemovePatternSource(doc, 'pt1', 0)
        expect(read(doc).source_features).toEqual([])
        applyRemovePatternSource(doc, 'pt1', 4)
        expect(read(doc).source_features).toEqual([])
      }
    })

    it('reorders the source chips and heals a legacy scalar first', () => {
      const doc = makeDoc()
      applyAddLinearPattern(doc, 'pt1', undefined, { subject: 'feature', source_features: ['@ex1', '@rv1'] })
      applyReorderPickField(doc, 'pt1', 'source_features', 0, 1)
      expect(linear0(doc).source_features).toEqual(['@rv1', '@ex1'])

      const legacy: PartDoc = {
        features: [{
          id: 'pt2', kind: 'linear_pattern',
          linear_pattern: { subject: 'feature', source_feature: '@ex2' },
        } as unknown as PartFeature],
      }
      applyReorderPickField(legacy, 'pt2', 'source_features', 0, 0)
      expect(linear0(legacy)).toMatchObject({ source_features: ['@ex2'] })
      expect(linear0(legacy)).not.toHaveProperty('source_feature')
    })
  })

  describe('the deprecated add_pattern alias', () => {
    it('translates a linear payload through the loader split', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1', 'Ring', { count: 4, pitch: 8, direction: [1, 0, 0] })
      expect(doc.features![0]).toMatchObject({
        id: 'pt1', kind: 'linear_pattern', label: 'Ring',
        linear_pattern: { subject: 'body', operation: 'add', count: 4, pitch: 8, direction: [1, 0, 0] },
      })
    })

    it('translates a rectangular payload to the second direction', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1', undefined, {
        mode: 'rectangular', count_x: 3, count_y: 2, pitch_x: 5, pitch_y: 6,
        direction_x_query: '@sk/lx', direction_y_query: '@sk/ly',
      })
      expect(doc.features![0].kind).toBe('linear_pattern')
      expect(linear0(doc)).toEqual({
        subject: 'body', operation: 'add', second_direction: true,
        count: 3, pitch: 5, direction_query: '@sk/lx',
        count_2: 2, pitch_2: 6, direction_2_query: '@sk/ly',
      })
    })

    it('translates a circular payload to the angle law', () => {
      const even = makeDoc()
      applyAddPattern(even, 'pt1', undefined, { mode: 'circular', axis: '@sk/c1' })
      expect(even.features![0].kind).toBe('circular_pattern')
      expect(circular0(even)).toMatchObject({ angle: 360, equal_spacing: true, count: 4, axis: '@sk/c1' })

      const stepped = makeDoc()
      applyAddPattern(stepped, 'pt2', undefined, { mode: 'circular', count: 4, step_angle: 30 })
      expect(circular0(stepped)).toMatchObject({ angle: 30, equal_spacing: false })
    })

    it('drops an unknown inline key such as include_source', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1', undefined, { count: 3, include_source: false } as never)
      expect(linear0(doc).count).toBe(3)
      expect(linear0(doc)).not.toHaveProperty('include_source')
    })

    it('lands a document the loader reopens unchanged', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1', undefined, { subject: 'body', count: 3, pitch: 20, direction: [1, 0, 0] })
      const loaded = loadPartDoc(doc)
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) return
      expect(loaded.migrations).toEqual([])
    })
  })
})
