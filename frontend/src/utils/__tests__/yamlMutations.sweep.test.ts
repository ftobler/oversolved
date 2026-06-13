import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddSweep,
  applySetSweepField,
  applyAddSweepProfile,
  applyRemoveSweepProfile,
  applyAddSweepPath,
  applyRemoveSweepPath,
  normalizeSweepSketch,
  normalizeSweepPath,
} from '@/utils/yamlMutations'

const baseDoc: PartDoc = { features: [] }

describe('add_sweep', () => {
  it('adds a sweep feature with profile array and path', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddSweep(doc, 'sw1', undefined, '$sk1', '$path1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('sweep')
    expect(doc.features![0].id).toBe('sw1')
    expect(doc.features![0].sweep).toBeDefined()
    expect(doc.features![0].sweep!.sketch).toEqual(['$sk1'])
    expect(doc.features![0].sweep!.path).toEqual(['$path1'])
  })

  it('stores empty profile array when sketchQuery is empty', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddSweep(doc, 'sw1', undefined, '', '$path1')
    expect(doc.features![0].sweep!.sketch).toEqual([])
  })

  it('uses label when provided, defaults to "Sweep" otherwise', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddSweep(doc, 'sw1', 'My Sweep', '$sk1', '$path1')
    expect(doc.features![0].label).toBe('My Sweep')
    const doc2: PartDoc = structuredClone(baseDoc)
    applyAddSweep(doc2, 'sw2', undefined, '$sk1', '$path1')
    expect(doc2.features![0].label).toBe('Sweep')
  })
})

describe('normalizeSweepSketch', () => {
  it('returns array unchanged', () => {
    expect(normalizeSweepSketch(['$sk1', '$sk2'])).toEqual(['$sk1', '$sk2'])
  })

  it('wraps non-empty string in array', () => {
    expect(normalizeSweepSketch('$sk1')).toEqual(['$sk1'])
  })

  it('returns empty array for empty string', () => {
    expect(normalizeSweepSketch('')).toEqual([])
  })
})

describe('add_sweep_profile', () => {
  it('appends a profile query and toggles it off when re-added', () => {
    const doc: PartDoc = {
      features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['$sk1'], path: '$p' } }],
    }
    applyAddSweepProfile(doc, 'sw1', '$sk2')
    expect(doc.features![0].sweep!.sketch).toEqual(['$sk1', '$sk2'])
    applyAddSweepProfile(doc, 'sw1', '$sk2')
    expect(doc.features![0].sweep!.sketch).toEqual(['$sk1'])
  })

  it('normalizes a string sketch before appending', () => {
    const doc: PartDoc = {
      features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: '$sk1', path: '$p' } }],
    }
    applyAddSweepProfile(doc, 'sw1', '$sk2')
    expect(doc.features![0].sweep!.sketch).toEqual(['$sk1', '$sk2'])
  })

  it('does nothing if sweep is undefined', () => {
    const doc: PartDoc = { features: [{ id: 'sw1', kind: 'sketch' }] }
    expect(() => applyAddSweepProfile(doc, 'sw1', '$sk2')).not.toThrow()
  })
})

describe('remove_sweep_profile', () => {
  it('removes the profile at the given index', () => {
    const doc: PartDoc = {
      features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['$sk1', '$sk2', '$sk3'], path: '$p' } }],
    }
    applyRemoveSweepProfile(doc, 'sw1', 1)
    expect(doc.features![0].sweep!.sketch).toEqual(['$sk1', '$sk3'])
  })

  it('does nothing if sweep is undefined', () => {
    const doc: PartDoc = { features: [{ id: 'sw1', kind: 'sketch' }] }
    expect(() => applyRemoveSweepProfile(doc, 'sw1', 0)).not.toThrow()
  })
})

describe('normalizeSweepPath', () => {
  it('returns array unchanged', () => {
    expect(normalizeSweepPath(['$p1', '$p2'])).toEqual(['$p1', '$p2'])
  })

  it('wraps a non-empty string in an array', () => {
    expect(normalizeSweepPath('$p1')).toEqual(['$p1'])
  })

  it('returns empty array for empty string or undefined', () => {
    expect(normalizeSweepPath('')).toEqual([])
    expect(normalizeSweepPath(undefined)).toEqual([])
  })
})

describe('add_sweep_path', () => {
  it('appends a path query and toggles it off when re-added', () => {
    const doc: PartDoc = {
      features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['$sk1'], path: ['$p1'] } }],
    }
    applyAddSweepPath(doc, 'sw1', '$p2')
    expect(doc.features![0].sweep!.path).toEqual(['$p1', '$p2'])
    applyAddSweepPath(doc, 'sw1', '$p2')
    expect(doc.features![0].sweep!.path).toEqual(['$p1'])
  })

  it('normalizes a legacy string path before appending', () => {
    const doc: PartDoc = {
      features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['$sk1'], path: '$p1' } }],
    }
    applyAddSweepPath(doc, 'sw1', '$p2')
    expect(doc.features![0].sweep!.path).toEqual(['$p1', '$p2'])
  })

  it('does nothing if sweep is undefined', () => {
    const doc: PartDoc = { features: [{ id: 'sw1', kind: 'sketch' }] }
    expect(() => applyAddSweepPath(doc, 'sw1', '$p2')).not.toThrow()
  })
})

describe('remove_sweep_path', () => {
  it('removes the path at the given index', () => {
    const doc: PartDoc = {
      features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: ['$sk1'], path: ['$p1', '$p2', '$p3'] } }],
    }
    applyRemoveSweepPath(doc, 'sw1', 1)
    expect(doc.features![0].sweep!.path).toEqual(['$p1', '$p3'])
  })

  it('does nothing if sweep is undefined', () => {
    const doc: PartDoc = { features: [{ id: 'sw1', kind: 'sketch' }] }
    expect(() => applyRemoveSweepPath(doc, 'sw1', 0)).not.toThrow()
  })
})

describe('set_sweep_field', () => {
  it('updates the path query', () => {
    const doc: PartDoc = {
      features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: '$sk1', path: '$p' } }],
    }
    applySetSweepField(doc, 'sw1', 'path', '?sk2/line1@sk2:straightedge')
    expect(doc.features![0].sweep!.path).toBe('?sk2/line1@sk2:straightedge')
  })

  it('updates the operation', () => {
    const doc: PartDoc = {
      features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: '$sk1', path: '$p', operation: 'add' } }],
    }
    applySetSweepField(doc, 'sw1', 'operation', 'cut')
    expect(doc.features![0].sweep!.operation).toBe('cut')
  })

  it('removes merge_target when empty string passed', () => {
    const doc: PartDoc = {
      features: [{ id: 'sw1', kind: 'sweep', sweep: { sketch: '$sk1', path: '$p', merge_target: '@body_ex0' } }],
    }
    applySetSweepField(doc, 'sw1', 'merge_target', '')
    expect(doc.features![0].sweep!).not.toHaveProperty('merge_target')
  })

  it('does nothing if sweep is undefined', () => {
    const doc: PartDoc = { features: [{ id: 'sw1', kind: 'sketch' }] }
    expect(() => applySetSweepField(doc, 'sw1', 'path', '$p')).not.toThrow()
    expect(doc.features![0]).not.toHaveProperty('sweep')
  })
})

describe('mutation does not mutate original doc', () => {
  it('add_sweep does not mutate original', () => {
    const doc: PartDoc = structuredClone(baseDoc)
    applyAddSweep(doc, 'sw1', undefined, '$sk1', '$path1')
    expect(baseDoc.features).toEqual([])
  })
})
