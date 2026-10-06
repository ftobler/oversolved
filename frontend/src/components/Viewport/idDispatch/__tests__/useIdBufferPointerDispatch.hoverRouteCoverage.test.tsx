import { describe, it, expect } from 'vitest'
import { HOVER_ROUTED_LAYERS, PART_EDITOR_CONSUMED_LAYERS } from '../useIdBufferPointerDispatch'

// L1: the click router's default is "select", the hover router's default is
// "do nothing", so a consumed layer with no hover route is selectable but never
// highlighted, silently. Both tables are exhaustive today; this pins it.
describe('hover route coverage', () => {
  it('every consumed layer has a hover route', () => {
    for (const layer of PART_EDITOR_CONSUMED_LAYERS) {
      expect(HOVER_ROUTED_LAYERS.has(layer), layer).toBe(true)
    }
  })
})
