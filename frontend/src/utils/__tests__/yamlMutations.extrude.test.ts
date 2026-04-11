import { describe, it, expect } from 'vitest'
import type { PartDoc } from '../../types/cad'
import { isBodyFeatureResult } from '../../types/cad'
import {
  applyAddExtrude,
  applySetExtrudeDistance,
  applySetExtrudeDirection,
  applySetExtrudeSketch,
} from '../yamlMutations'

const baseDoc: PartDoc = { features: [] }

describe('add_extrude', () => {
  it('adds an extrude feature with correct properties', () => {
    const doc: PartDoc = JSON.parse(JSON.stringify(baseDoc))
    applyAddExtrude(doc, 'ex1', undefined, '$sk1', 10)
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0].kind).toBe('extrude')
    expect(doc.features![0].id).toBe('ex1')
    expect(doc.features![0].extrude).toBeDefined()
    expect(doc.features![0].extrude!.distance).toBe(10)
    expect(doc.features![0].extrude!.sketch).toBe('$sk1')
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

describe('set_extrude_sketch', () => {
  it('updates extrude sketch', () => {
    const doc: PartDoc = {
      features: [
        {
          id: 'ex1',
          kind: 'extrude',
          extrude: { sketch: '$sk1', distance: 10 },
        },
      ],
    }
    applySetExtrudeSketch(doc, 'ex1', '$sk2')
    expect(doc.features![0].extrude!.sketch).toBe('$sk2')
  })

  it('does nothing if extrude is undefined', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'sketch' }],
    }
    expect(() => applySetExtrudeSketch(doc, 'ex1', '$sk2')).not.toThrow()
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

  it('set_extrude_sketch does not mutate original', () => {
    const original = { features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 10 } }] }
    const doc = JSON.parse(JSON.stringify(original))
    applySetExtrudeSketch(doc, 'ex1', '$sk2')
    expect(original.features![0].extrude!.sketch).toBe('$sk1')
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