import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddRevolve,
  applySetRevolveField,
  applyAddRevolveProfile,
  applyRemoveRevolveProfile,
  normalizeRevolveSketch,
} from '@/utils/yamlMutations'

const baseDoc: PartDoc = { features: [] }

describe('add_revolve', () => {
  it('adds a revolve feature with sketch as an array', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '$sk1', 360)
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('revolve')
    expect(doc.features![0].id).toBe('rev1')
    expect(doc.features![0].revolve).toBeDefined()
    expect(doc.features![0].revolve!.angle).toBe(360)
    expect(doc.features![0].revolve!.sketch).toEqual(['$sk1'])
  })

  it('stores empty array when sketchQuery is empty string', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '', 360)
    expect(doc.features![0].revolve!.sketch).toEqual([])
  })

  it('uses label when provided', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', 'My Revolve', '$sk1', 360)
    expect(doc.features![0].label).toBe('My Revolve')
  })

  it('defaults label to "Revolve" when not provided', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '$sk1', 360)
    expect(doc.features![0].label).toBe('Revolve')
  })

  it('defaults axis_origin and axis_direction', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '$sk1', 360)
    expect(doc.features![0].revolve!.axis_origin).toEqual([0, 0, 0])
    expect(doc.features![0].revolve!.axis_direction).toEqual([0, 0, 1])
  })
})

describe('normalizeRevolveSketch', () => {
  it('returns array unchanged', () => {
    expect(normalizeRevolveSketch(['$sk1', '$sk2'])).toEqual(['$sk1', '$sk2'])
  })

  it('wraps non-empty string in array', () => {
    expect(normalizeRevolveSketch('$sk1')).toEqual(['$sk1'])
  })

  it('returns empty array for empty string', () => {
    expect(normalizeRevolveSketch('')).toEqual([])
  })

  it('returns empty array for empty array', () => {
    expect(normalizeRevolveSketch([])).toEqual([])
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
    expect(doc.features![0].revolve!.sketch).toEqual(['$sk1', '$sk2'])
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
    expect(doc.features![0].revolve!.sketch).toEqual(['$sk1', '$sk2'])
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
    expect(doc.features![0].revolve!.sketch).toEqual(['$sk2'])
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    expect(() => applyAddRevolveProfile(doc, 'rev1', '$sk2')).not.toThrow()
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
    expect(doc.features![0].revolve!.sketch).toEqual(['$sk1', '$sk3'])
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
    expect(doc.features![0].revolve!.sketch).toEqual([])
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
    expect(doc.features![0].revolve!.sketch).toEqual([])
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    expect(() => applyRemoveRevolveProfile(doc, 'rev1', 0)).not.toThrow()
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
    expect(doc.features![0].revolve!.angle).toBe(180)
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    expect(() =>     applySetRevolveField(doc, 'rev1', 'angle', 180)).not.toThrow()
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
    expect(doc.features![0].revolve!.direction).toBe('reverse')
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
    expect(doc.features![0].revolve!.direction).toBe('symmetric')
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    expect(() => applySetRevolveField(doc, 'rev1', 'direction', 'reverse')).not.toThrow()
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
    expect(doc.features![0].revolve!.axis).toBe('?sk1/line1:start@sk1:straightedge')
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    expect(() => applySetRevolveField(doc, 'rev1', 'axis', '?some:edge')).not.toThrow()
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
    expect(doc.features![0].revolve!.operation).toBe('cut')
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
    expect(doc.features![0].revolve!.operation).toBe('new')
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    expect(() => applySetRevolveField(doc, 'rev1', 'operation', 'cut')).not.toThrow()
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
    expect(doc.features![0].revolve!.merge_target).toBe('@body_ex0')
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
    expect(doc.features![0].revolve!).not.toHaveProperty('merge_target')
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
    expect(doc.features![0].revolve!).not.toHaveProperty('merge_target')
  })

  it('does nothing if revolve is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'rev1', kind: 'sketch' }],
    }
    expect(() => applySetRevolveField(doc, 'rev1', 'merge_target', '@body_ex0')).not.toThrow()
  })
})

describe('mutation does not mutate original doc', () => {
  it('add_revolve does not mutate original', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddRevolve(doc, 'rev1', undefined, '$sk1', 360)
    expect(baseDoc.features).toEqual([])
  })

  it('set_revolve_angle does not mutate original', () => {
    const original = { features: [{ id: 'rev1', kind: 'revolve', revolve: { sketch: '$sk1', angle: 90 } }] }
    const doc = structuredClone(original)
    applySetRevolveField(doc, 'rev1', 'angle', 180)
    expect(original.features![0].revolve!.angle).toBe(90)
  })
})
