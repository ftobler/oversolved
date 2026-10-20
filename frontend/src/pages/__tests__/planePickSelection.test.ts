import { describe, it, expect } from 'vitest'
import { planeSelectionFeatureId } from '@/pages/planePickSelection'
import type { PartFeature } from '@/types/cad'

const FEATURES: PartFeature[] = [
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1' },
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: '$sk1', distance: 10 } },
]

describe('plane selection derivation', () => {
  it('returns a sketch whose plane field is armed', () => {
    expect(planeSelectionFeatureId({ featureId: 'sk1', field: 'plane' }, FEATURES)).toBe('sk1')
  })

  it('ignores a bug report pick field, even one called plane', () => {
    // The report's field ids are `bug-report:<setId>`, which names no feature;
    // the sketch-on-face FSM must not start from a report pick.
    expect(planeSelectionFeatureId({ featureId: 'bug-report:set-1', field: 'plane' }, FEATURES)).toBeNull()
  })

  it('ignores a non-sketch feature and a non-plane field', () => {
    expect(planeSelectionFeatureId({ featureId: 'ex1', field: 'plane' }, FEATURES)).toBeNull()
    expect(planeSelectionFeatureId({ featureId: 'sk1', field: 'edges' }, FEATURES)).toBeNull()
    expect(planeSelectionFeatureId(null, FEATURES)).toBeNull()
  })
})
