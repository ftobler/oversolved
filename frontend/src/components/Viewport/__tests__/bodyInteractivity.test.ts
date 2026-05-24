import { describe, it, expect } from 'vitest'
import { arePickBodiesInteractive } from '../bodyInteractivity'

describe('arePickBodiesInteractive', () => {
  it('bodies interactive when no sketch is being edited', () => {
    expect(arePickBodiesInteractive(null, null)).toBe(true)
    expect(arePickBodiesInteractive(undefined, null)).toBe(true)
    expect(arePickBodiesInteractive(undefined, { featureId: 'sk1', field: 'plane' })).toBe(true)
  })

  it('bodies inert while editing a sketch with no active plane pick', () => {
    expect(arePickBodiesInteractive('sk1', null)).toBe(false)
    expect(arePickBodiesInteractive('sk1', { featureId: 'sk1', field: 'edges' })).toBe(false)
  })

  it('bodies stay interactive during a plane pick so a solid face can be chosen as the sketch plane', () => {
    expect(arePickBodiesInteractive('sk1', { featureId: 'sk1', field: 'plane' })).toBe(true)
  })
})
