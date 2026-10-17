import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TESSELLATION_PRESET,
  TESSELLATION_PRESET_ORDER,
  TESSELLATION_PRESETS,
  resolveTessellation,
} from '../tessellationPresets'

// The shared preset table the dialog and the worker both read. Smaller
// deflection means more triangles, so finer presets carry strictly smaller
// values; the ordering here is what the curved-part real test relies on.
describe('tessellation presets', () => {
  it('exposes exactly three presets in coarse-to-fine-free order', () => {
    expect(TESSELLATION_PRESET_ORDER).toEqual(['fine', 'normal', 'coarse'])
    expect(Object.keys(TESSELLATION_PRESETS).sort()).toEqual(['coarse', 'fine', 'normal'])
  })

  it('steps both deflections monotonically: fine shrinks them, coarse grows them', () => {
    const { fine, normal, coarse } = TESSELLATION_PRESETS
    expect(fine.linearDeflection).toBeLessThan(normal.linearDeflection)
    expect(normal.linearDeflection).toBeLessThan(coarse.linearDeflection)
    expect(fine.angularDeflection).toBeLessThan(normal.angularDeflection)
    expect(normal.angularDeflection).toBeLessThan(coarse.angularDeflection)
  })

  // normal must not move a single triangle from the pre-preset export: the old
  // dialog default (slider 0.5) mapped to exactly linear 1.0, angular 0.3.
  it('pins normal to the pre-preset export deflections', () => {
    expect(resolveTessellation('normal')).toEqual({ linearDeflection: 1, angularDeflection: 0.3 })
  })

  it('defaults to normal when no preset is named', () => {
    expect(DEFAULT_TESSELLATION_PRESET).toBe('normal')
    expect(resolveTessellation()).toEqual(resolveTessellation('normal'))
  })
})
