import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { isBodyFeatureResult } from '@/types/cad'
import {
  applyAddExtrude,
  applySetExtrudeField,
  applyAddExtrudeProfile,
  applyRemoveExtrudeProfile,
  normalizeRefList,
} from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'

const extrude0 = (doc: PartDoc) => featureAt(doc, 0, 'extrude').extrude

const baseDoc: PartDoc = { features: [] }

describe('add_extrude', () => {
  it('adds an extrude feature with sketch as an array', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('extrude')
    expect(doc.features![0].id).toBe('ex1')
    expect(extrude0(doc)).toBeDefined()
    expect(extrude0(doc).distance).toBe(10)
    expect(extrude0(doc).sketch).toEqual(['$sk1'])
  })

  it('stores empty array when sketchQuery is empty string', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddExtrude(doc, 'ex1', undefined, '', 10)
    expect(extrude0(doc).sketch).toEqual([])
  })

  it('uses label when provided', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddExtrude(doc, 'ex1', 'My Extrude', '$sk1', 10)
    expect(doc.features![0].label).toBe('My Extrude')
  })

  it('defaults label to "Extrude" when not provided', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(doc.features![0].label).toBe('Extrude')
  })

  it('defaults direction to normal', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(extrude0(doc).direction).toBe('normal')
  })

  it('writes termination and up_to when the add carries them inline', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10, { termination: 'up_to', up_to: '@pl1' })
    expect(extrude0(doc)).toMatchObject({ termination: 'up_to', up_to: '@pl1' })
  })

  it('leaves termination and up_to absent when the add omits them', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(extrude0(doc)).not.toHaveProperty('termination')
    expect(extrude0(doc)).not.toHaveProperty('up_to')
  })
})

describe('normalizeRefList', () => {
  it('returns array unchanged', () => {
    expect(normalizeRefList(['$sk1', '$sk2'])).toEqual(['$sk1', '$sk2'])
  })

  it('wraps non-empty string in array', () => {
    expect(normalizeRefList('$sk1')).toEqual(['$sk1'])
  })

  it('returns empty array for empty string', () => {
    expect(normalizeRefList('')).toEqual([])
  })

  it('returns empty array for empty array', () => {
    expect(normalizeRefList([])).toEqual([])
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
    expect(extrude0(doc).sketch).toEqual(['$sk1', '$sk2'])
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
    expect(extrude0(doc).sketch).toEqual(['$sk1', '$sk2'])
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
    expect(extrude0(doc).sketch).toEqual(['$sk2'])
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applyAddExtrudeProfile(doc, 'ex1', '$sk2')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('extrude')
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
    expect(extrude0(doc).sketch).toEqual(['$sk1', '$sk3'])
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
    expect(extrude0(doc).sketch).toEqual([])
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
    expect(extrude0(doc).sketch).toEqual([])
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applyRemoveExtrudeProfile(doc, 'ex1', 0)
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('extrude')
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
    applySetExtrudeField(doc, 'ex1', 'distance', 20)
    expect(extrude0(doc).distance).toBe(20)
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applySetExtrudeField(doc, 'ex1', 'distance', 20)
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('extrude')
  })

  it('does nothing for unknown feature', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    const before = structuredClone(doc)
    applySetExtrudeField(doc, 'nonexistent', 'distance', 20)
    expect(doc).toEqual(before)
    expect(doc.features).toEqual([])
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
    applySetExtrudeField(doc, 'ex1', 'direction', 'symmetric')
    expect(extrude0(doc).direction).toBe('symmetric')
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
    applySetExtrudeField(doc, 'ex1', 'direction', 'reverse')
    expect(extrude0(doc).direction).toBe('reverse')
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applySetExtrudeField(doc, 'ex1', 'direction', 'symmetric')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('extrude')
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
    applySetExtrudeField(doc, 'ex1', 'operation', 'cut')
    expect(extrude0(doc).operation).toBe('cut')
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
    applySetExtrudeField(doc, 'ex1', 'operation', 'add')
    expect(extrude0(doc).operation).toBe('add')
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
    applySetExtrudeField(doc, 'ex1', 'operation', 'cut')
    expect(extrude0(doc).operation).toBe('cut')
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applySetExtrudeField(doc, 'ex1', 'operation', 'cut')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('extrude')
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
    applySetExtrudeField(doc, 'ex1', 'operation', 'new')
    expect(extrude0(doc).operation).toBe('new')
  })
})

describe('mutation does not mutate original doc', () => {
  it('add_extrude does not mutate original', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(baseDoc.features).toEqual([])
  })

  it('set_extrude_distance does not mutate original', () => {
    const original: PartDoc = { features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 5 } }] }
    const doc = structuredClone(original)
    applySetExtrudeField(doc, 'ex1', 'distance', 20)
    expect(extrude0(original).distance).toBe(5)
  })

  it('set_extrude_direction does not mutate original', () => {
    const original: PartDoc = { features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } }] }
    const doc = structuredClone(original) as PartDoc
    applySetExtrudeField(doc, 'ex1', 'direction', 'symmetric')
    expect(extrude0(original).direction).toBe('normal')
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
    applySetExtrudeField(doc, 'ex1', 'merge_target', '@body_ex0')
    expect(extrude0(doc).merge_target).toBe('@body_ex0')
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
    applySetExtrudeField(doc, 'ex1', 'merge_target', undefined)
    expect(extrude0(doc).merge_target).toBeUndefined()
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applySetExtrudeField(doc, 'ex1', 'merge_target', '@body_ex0')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('extrude')
  })

  it('does nothing for unknown feature', () => {
    const doc: PartDoc = { features: [] }
    const before = structuredClone(doc)
    applySetExtrudeField(doc, 'nonexistent', 'merge_target', '@body_ex0')
    expect(doc).toEqual(before)
    expect(doc.features).toEqual([])
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
