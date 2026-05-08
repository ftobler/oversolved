import { describe, it, expect } from 'vitest'
import type { PartDoc } from '../../types/cad'
import { isBodyFeatureResult } from '../../types/cad'
import {
  applyAddExtrude,
  applySetExtrudeDistance,
  applySetExtrudeDirection,
  applySetExtrudeOperation,
  applyAddExtrudeProfile,
  applyRemoveExtrudeProfile,
  applySetExtrudeMergeTarget,
  normalizeExtrudeSketch,
} from '../yamlMutations'

const baseDoc: PartDoc = { features: [] }

describe('add_extrude', () => {
  it('adds an extrude feature with sketch as an array', () => {
    const doc: PartDoc = JSON.parse(JSON.stringify(baseDoc))
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('extrude')
    expect(doc.features![0].id).toBe('ex1')
    expect(doc.features![0].extrude).toBeDefined()
    expect(doc.features![0].extrude!.distance).toBe(10)
    expect(doc.features![0].extrude!.sketch).toEqual(['$sk1'])
  })

  it('stores empty array when sketchQuery is empty string', () => {
    const doc: PartDoc = JSON.parse(JSON.stringify(baseDoc))
    applyAddExtrude(doc, 'ex1', undefined, '', 10)
    expect(doc.features![0].extrude!.sketch).toEqual([])
  })

  it('uses label when provided', () => {
    const doc: PartDoc = JSON.parse(JSON.stringify(baseDoc))
    applyAddExtrude(doc, 'ex1', 'My Extrude', '$sk1', 10)
    expect(doc.features![0].label).toBe('My Extrude')
  })

  it('defaults label to "Extrude" when not provided', () => {
    const doc: PartDoc = JSON.parse(JSON.stringify(baseDoc))
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(doc.features![0].label).toBe('Extrude')
  })

  it('defaults direction to normal', () => {
    const doc: PartDoc = JSON.parse(JSON.stringify(baseDoc))
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(doc.features![0].extrude!.direction).toBe('normal')
  })
})

describe('normalizeExtrudeSketch', () => {
  it('returns array unchanged', () => {
    expect(normalizeExtrudeSketch(['$sk1', '$sk2'])).toEqual(['$sk1', '$sk2'])
  })

  it('wraps non-empty string in array', () => {
    expect(normalizeExtrudeSketch('$sk1')).toEqual(['$sk1'])
  })

  it('returns empty array for empty string', () => {
    expect(normalizeExtrudeSketch('')).toEqual([])
  })

  it('returns empty array for empty array', () => {
    expect(normalizeExtrudeSketch([])).toEqual([])
  })
})

describe('add_extrude_profile', () => {
  it('appends a profile query to an existing list', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: ['$sk1'], distance: 10 },
        },
      ],
    }
    applyAddExtrudeProfile(doc, 'ex1', '$sk2')
    expect(doc.features![0].extrude!.sketch).toEqual(['$sk1', '$sk2'])
  })

  it('normalizes a string sketch before appending', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10 },
        },
      ],
    }
    applyAddExtrudeProfile(doc, 'ex1', '$sk2')
    expect(doc.features![0].extrude!.sketch).toEqual(['$sk1', '$sk2'])
  })

  it('toggles off an existing profile query', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: ['$sk1', '$sk2'], distance: 10 },
        },
      ],
    }
    applyAddExtrudeProfile(doc, 'ex1', '$sk1')
    expect(doc.features![0].extrude!.sketch).toEqual(['$sk2'])
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    expect(() => applyAddExtrudeProfile(doc, 'ex1', '$sk2')).not.toThrow()
  })
})

describe('remove_extrude_profile', () => {
  it('removes the profile at the given index', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: ['$sk1', '$sk2', '$sk3'], distance: 10 },
        },
      ],
    }
    applyRemoveExtrudeProfile(doc, 'ex1', 1)
    expect(doc.features![0].extrude!.sketch).toEqual(['$sk1', '$sk3'])
  })

  it('removes the only profile leaving empty list', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: ['$sk1'], distance: 10 },
        },
      ],
    }
    applyRemoveExtrudeProfile(doc, 'ex1', 0)
    expect(doc.features![0].extrude!.sketch).toEqual([])
  })

  it('normalizes string sketch before removing', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10 },
        },
      ],
    }
    applyRemoveExtrudeProfile(doc, 'ex1', 0)
    expect(doc.features![0].extrude!.sketch).toEqual([])
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    expect(() => applyRemoveExtrudeProfile(doc, 'ex1', 0)).not.toThrow()
  })
})

describe('set_extrude_distance', () => {
  it('updates extrude distance', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 5 },
        },
      ],
    }
    applySetExtrudeDistance(doc, 'ex1', 20)
    expect(doc.features![0].extrude!.distance).toBe(20)
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    expect(() => applySetExtrudeDistance(doc, 'ex1', 20)).not.toThrow()
    expect(doc.features![0]).not.toHaveProperty('extrude')
  })

  it('does nothing for unknown feature', () => {
    const doc: PartDoc = JSON.parse(JSON.stringify(baseDoc))
    expect(() => applySetExtrudeDistance(doc, 'nonexistent', 20)).not.toThrow()
  })
})

describe('set_extrude_direction', () => {
  it('updates extrude direction', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
        },
      ],
    }
    applySetExtrudeDirection(doc, 'ex1', 'symmetric')
    expect(doc.features![0].extrude!.direction).toBe('symmetric')
  })

  it('handles reverse direction', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10 },
        },
      ],
    }
    applySetExtrudeDirection(doc, 'ex1', 'reverse')
    expect(doc.features![0].extrude!.direction).toBe('reverse')
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    expect(() => applySetExtrudeDirection(doc, 'ex1', 'symmetric')).not.toThrow()
  })
})

describe('set_extrude_operation', () => {
  it('updates extrude operation to cut', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10, operation: 'add' },
        },
      ],
    }
    applySetExtrudeOperation(doc, 'ex1', 'cut')
    expect(doc.features![0].extrude!.operation).toBe('cut')
  })

  it('updates extrude operation back to add', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10, operation: 'cut' },
        },
      ],
    }
    applySetExtrudeOperation(doc, 'ex1', 'add')
    expect(doc.features![0].extrude!.operation).toBe('add')
  })

  it('sets operation when field is absent', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10 },
        },
      ],
    }
    applySetExtrudeOperation(doc, 'ex1', 'cut')
    expect(doc.features![0].extrude!.operation).toBe('cut')
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    expect(() => applySetExtrudeOperation(doc, 'ex1', 'cut')).not.toThrow()
  })

  it('sets extrude operation to new', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10, operation: 'add' },
        },
      ],
    }
    applySetExtrudeOperation(doc, 'ex1', 'new')
    expect(doc.features![0].extrude!.operation).toBe('new')
  })
})

describe('mutation does not mutate original doc', () => {
  it('add_extrude does not mutate original', () => {
    const doc: PartDoc = JSON.parse(JSON.stringify(baseDoc))
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(baseDoc.features).toEqual([])
  })

  it('set_extrude_distance does not mutate original', () => {
    const original = { features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 5 } }] }
    const doc = JSON.parse(JSON.stringify(original))
    applySetExtrudeDistance(doc, 'ex1', 20)
    expect(original.features![0].extrude!.distance).toBe(5)
  })

  it('set_extrude_direction does not mutate original', () => {
    const original = { features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } }] }
    const doc = JSON.parse(JSON.stringify(original))
    applySetExtrudeDirection(doc, 'ex1', 'symmetric')
    expect(original.features![0].extrude!.direction).toBe('normal')
  })
})

describe('set_extrude_merge_target', () => {
  it('sets merge_target on an extrude feature', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10 },
        },
      ],
    }
    applySetExtrudeMergeTarget(doc, 'ex1', '@body_ex0')
    expect(doc.features![0].extrude!.merge_target).toBe('@body_ex0')
  })

  it('removes merge_target when called without value', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10, merge_target: '@body_ex0' },
        },
      ],
    }
    applySetExtrudeMergeTarget(doc, 'ex1')
    expect(doc.features![0].extrude!.merge_target).toBeUndefined()
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    expect(() => applySetExtrudeMergeTarget(doc, 'ex1', '@body_ex0')).not.toThrow()
  })

  it('does nothing for unknown feature', () => {
    const doc: PartDoc = { features: [] }
    expect(() => applySetExtrudeMergeTarget(doc, 'nonexistent', '@body_ex0')).not.toThrow()
  })
})

describe('isBodyFeatureResult type guard', () => {
  it('returns true for object with body_id', () => {
    expect(isBodyFeatureResult({ body_id: 'x', status: 'ok' })).toBe(true)
  })

  it('returns true for object with body_id and exception', () => {
    expect(isBodyFeatureResult({ body_id: 'x', status: 'exception', exception: 'some error' })).toBe(true)
  })

  it('returns false for object without body_id', () => {
    expect(isBodyFeatureResult({ geometry: {} })).toBe(false)
  })

  it('returns false for null', () => {
    expect(isBodyFeatureResult(null)).toBe(false)
  })

  it('returns false for primitive', () => {
    expect(isBodyFeatureResult('string')).toBe(false)
    expect(isBodyFeatureResult(123)).toBe(false)
  })
})
