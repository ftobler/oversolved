import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddPattern,
  applySetPatternField,
} from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'

const pattern0 = (doc: PartDoc) => featureAt(doc, 0, 'pattern').pattern

const baseDoc: PartDoc = { features: [] }

const makeDoc = (): PartDoc => structuredClone(baseDoc)

describe('Pattern mutations (body subject)', () => {
  describe('applyAddPattern', () => {
    it('inserts a feature with correct defaults', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1')
      expect(doc.features).toHaveLength(1)
      expect(doc.features![0]).toMatchObject({
        id: 'pt1',
        kind: 'pattern',
        label: 'Pattern',
        pattern: {
          subject: 'body',
          mode: 'linear',
          count: 2,
          pitch: 20,
          operation: 'add',
        },
      })
    })

    it('uses custom label when provided', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1', 'My Pattern')
      expect(doc.features![0].label).toBe('My Pattern')
    })

    it('seeds the circular count when that mode is authored inline', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1', undefined, { mode: 'circular' })
      expect(pattern0(doc)).toMatchObject({ mode: 'circular', count: 4 })
    })
  })

  describe('applySetPatternField mode seeding', () => {
    it('sets mode to rectangular and adds Y defaults', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1')
      applySetPatternField(doc, 'pt1', 'mode', 'rectangular')
      expect(pattern0(doc).mode).toBe('rectangular')
      expect(pattern0(doc).count_y).toBe(2)
      expect(pattern0(doc).pitch_y).toBe(20)
    })

    it('sets mode to linear and clears Y fields', () => {
      const doc = makeDoc()
      applyAddPattern(doc, 'pt1')
      applySetPatternField(doc, 'pt1', 'mode', 'rectangular')
      applySetPatternField(doc, 'pt1', 'mode', 'linear')
      expect(pattern0(doc).mode).toBe('linear')
      expect(pattern0(doc).count_y).toBeUndefined()
    })

    // A hand-edited pattern can carry a mode without the X spacing fields;
    // switching it to rectangular must fill both axes rather than leave a hole
    // the solver would read as a zero-count pattern.
    it('fills the missing X defaults when a pattern becomes rectangular', () => {
      const doc: PartDoc = {
        features: [{
          id: 'pt1', kind: 'pattern',
          pattern: { subject: 'body', mode: 'linear', operation: 'add' },
        }],
      }
      applySetPatternField(doc, 'pt1', 'mode', 'rectangular')
      expect(pattern0(doc)).toMatchObject({
        mode: 'rectangular', count_x: 2, pitch_x: 20, count_y: 2, pitch_y: 20,
      })
    })
  })
})
