import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddRevolve,
  applySetRevolveField,
  applyAddRevolveProfile,
  applyRemoveRevolveProfile,
  normalizeRefList,
} from '@/utils/yamlMutations'
import { featureAt } from '@/testing/featureAccess'

const revolve0 = (doc: PartDoc) => featureAt(doc, 0, 'revolve').revolve

const baseDoc: PartDoc = { features: [] }

describe('add_revolve', () => {
  it('adds a revolve feature with sketch as an array', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '$sk1', 360, '@sk1/ax')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('revolve')
    expect(doc.features![0].id).toBe('rev1')
    expect(revolve0(doc)).toBeDefined()
    expect(revolve0(doc).angle).toBe(360)
    expect(revolve0(doc).sketch).toEqual(['$sk1'])
  })

  it('stores empty array when sketchQuery is empty string', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '', 360, '@sk1/ax')
    expect(revolve0(doc).sketch).toEqual([])
  })

  it('uses label when provided', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', 'My Revolve', '$sk1', 360, '@sk1/ax')
    expect(doc.features![0].label).toBe('My Revolve')
  })

  it('defaults label to "Revolve" when not provided', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '$sk1', 360, '@sk1/ax')
    expect(doc.features![0].label).toBe('Revolve')
  })

  it('stores the inline axis with the profile and angle', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '$sk1', 360, '@sk1/ax')
    expect(revolve0(doc).axis).toBe('@sk1/ax')
  })

  it('leaves an absent axis absent instead of filling a default', () => {
    // A pre-filled [0,0,0]/[0,0,1] axis made a never-picked axis solve about
    // world Z; the revolve leaf now rejects an axis-less feature instead.
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '$sk1', 360)
    expect(revolve0(doc)).not.toHaveProperty('axis')
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

describe('add_revolve_profile', () => {
  it('appends a profile query to an existing list', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: ['$sk1'], angle: 360 },
        },
      ],
    }
    applyAddRevolveProfile(doc, 'rev1', '$sk2')
    expect(revolve0(doc).sketch).toEqual(['$sk1', '$sk2'])
  })

  it('normalizes a string sketch before appending', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: '$sk1', angle: 360 },
        },
      ],
    }
    applyAddRevolveProfile(doc, 'rev1', '$sk2')
    expect(revolve0(doc).sketch).toEqual(['$sk1', '$sk2'])
  })

  it('toggles off an existing profile query', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: ['$sk1', '$sk2'], angle: 360 },
        },
      ],
    }
    applyAddRevolveProfile(doc, 'rev1', '$sk1')
    expect(revolve0(doc).sketch).toEqual(['$sk2'])
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applyAddRevolveProfile(doc, 'rev1', '$sk2')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('revolve')
  })
})

describe('remove_revolve_profile', () => {
  it('removes the profile at the given index', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: ['$sk1', '$sk2', '$sk3'], angle: 360 },
        },
      ],
    }
    applyRemoveRevolveProfile(doc, 'rev1', 1)
    expect(revolve0(doc).sketch).toEqual(['$sk1', '$sk3'])
  })

  it('removes the only profile leaving empty list', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: ['$sk1'], angle: 360 },
        },
      ],
    }
    applyRemoveRevolveProfile(doc, 'rev1', 0)
    expect(revolve0(doc).sketch).toEqual([])
  })

  it('normalizes string sketch before removing', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: '$sk1', angle: 360 },
        },
      ],
    }
    applyRemoveRevolveProfile(doc, 'rev1', 0)
    expect(revolve0(doc).sketch).toEqual([])
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applyRemoveRevolveProfile(doc, 'rev1', 0)
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('revolve')
  })
})

describe('set_revolve_angle', () => {
  it('updates revolve angle', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: '$sk1', angle: 90 },
        },
      ],
    }
    applySetRevolveField(doc, 'rev1', 'angle', 180)
    expect(revolve0(doc).angle).toBe(180)
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applySetRevolveField(doc, 'rev1', 'angle', 180)
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('revolve')
  })
})

describe('set_revolve_direction', () => {
  it('updates revolve direction to reverse', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: '$sk1', angle: 360 },
        },
      ],
    }
    applySetRevolveField(doc, 'rev1', 'direction', 'reverse')
    expect(revolve0(doc).direction).toBe('reverse')
  })

  it('updates revolve direction to symmetric', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: '$sk1', angle: 360, direction: 'normal' },
        },
      ],
    }
    applySetRevolveField(doc, 'rev1', 'direction', 'symmetric')
    expect(revolve0(doc).direction).toBe('symmetric')
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applySetRevolveField(doc, 'rev1', 'direction', 'reverse')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('revolve')
  })
})

describe('set_revolve_axis', () => {
  it('updates revolve axis query', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: '$sk1', angle: 360 },
        },
      ],
    }
    applySetRevolveField(doc, 'rev1', 'axis', '?sk1/line1:start@sk1:straightedge')
    expect(revolve0(doc).axis).toBe('?sk1/line1:start@sk1:straightedge')
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applySetRevolveField(doc, 'rev1', 'axis', '?some:edge')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('revolve')
  })
})

describe('set_revolve_operation', () => {
  it('updates revolve operation to cut', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: '$sk1', angle: 360, operation: 'add' },
        },
      ],
    }
    applySetRevolveField(doc, 'rev1', 'operation', 'cut')
    expect(revolve0(doc).operation).toBe('cut')
  })

  it('sets operation when field is absent', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: '$sk1', angle: 360 },
        },
      ],
    }
    applySetRevolveField(doc, 'rev1', 'operation', 'new')
    expect(revolve0(doc).operation).toBe('new')
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applySetRevolveField(doc, 'rev1', 'operation', 'cut')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('revolve')
  })
})

describe('set_revolve_merge_target', () => {
  it('sets merge_target on revolve sub-dict', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: ['$sk1'], angle: 360 },
        },
      ],
    }
    applySetRevolveField(doc, 'rev1', 'merge_target', '@body_ex0')
    expect(revolve0(doc).merge_target).toBe('@body_ex0')
  })

  it('removes merge_target when argument is empty', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: ['$sk1'], angle: 360, merge_target: '@body_ex0' },
        },
      ],
    }
    applySetRevolveField(doc, 'rev1', 'merge_target', undefined)
    expect(revolve0(doc)).not.toHaveProperty('merge_target')
  })

  it('removes merge_target when empty string passed', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'rev1',
          kind: 'revolve',
          revolve: { sketch: ['$sk1'], angle: 360, merge_target: '@body_ex0' },
        },
      ],
    }
    applySetRevolveField(doc, 'rev1', 'merge_target', '')
    expect(revolve0(doc)).not.toHaveProperty('merge_target')
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    const before = structuredClone(doc)
    applySetRevolveField(doc, 'rev1', 'merge_target', '@body_ex0')
    expect(doc).toEqual(before)
    expect(doc.features![0]).not.toHaveProperty('revolve')
  })
})

describe('mutation does not mutate original doc', () => {
  it('add_revolve does not mutate original', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '$sk1', 360, '@sk1/ax')
    expect(baseDoc.features).toEqual([])
  })

  it('set_revolve_angle does not mutate original', () => {
    const original: PartDoc = { features: [{ id: 'rev1', kind: 'revolve', revolve: { sketch: '$sk1', angle: 90 } }] }
    const doc = structuredClone(original)
    applySetRevolveField(doc, 'rev1', 'angle', 180)
    expect(revolve0(original).angle).toBe(90)
  })
})
