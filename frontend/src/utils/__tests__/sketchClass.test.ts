import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { isSketchClassFeature } from '@/utils/sketchClass'

const feature = (kind: string): PartFeature => ({ id: 'f1', kind } as PartFeature)

describe('isSketchClassFeature', () => {
  it('is true for a sketch and a helix', () => {
    expect(isSketchClassFeature(feature('sketch'))).toBe(true)
    expect(isSketchClassFeature(feature('helix'))).toBe(true)
  })

  it('is false for a plane and for solid-producing features', () => {
    expect(isSketchClassFeature(feature('plane'))).toBe(false)
    expect(isSketchClassFeature(feature('extrude'))).toBe(false)
    expect(isSketchClassFeature(feature('sweep'))).toBe(false)
  })

  it('is false for a missing feature', () => {
    expect(isSketchClassFeature(undefined)).toBe(false)
    expect(isSketchClassFeature(null)).toBe(false)
  })
})
