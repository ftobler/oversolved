import { describe, it, expect } from 'vitest'
import { RENDER_ORDER_DEFAULT, RENDER_ORDER_EDITING, RENDER_ORDER_HIGHLIGHT } from '@/utils/core/partColors'
import * as geomConstants from '@/components/Geometry3D/constants'
import { entityRenderLayer } from '@/components/Geometry3D/constants'

describe('render order constants', () => {
  it('defines RENDER_ORDER_DEFAULT as 0', () => {
    expect(RENDER_ORDER_DEFAULT).toBe(0)
  })

  it('defines RENDER_ORDER_EDITING as 10', () => {
    expect(RENDER_ORDER_EDITING).toBe(10)
  })

  it('defines RENDER_ORDER_HIGHLIGHT as 999', () => {
    expect(RENDER_ORDER_HIGHLIGHT).toBe(999)
  })

  it('editing > default', () => {
    expect(RENDER_ORDER_EDITING).toBeGreaterThan(RENDER_ORDER_DEFAULT)
  })

  it('highlight > all others', () => {
    expect(RENDER_ORDER_HIGHLIGHT).toBeGreaterThan(RENDER_ORDER_EDITING)
    expect(RENDER_ORDER_HIGHLIGHT).toBeGreaterThan(RENDER_ORDER_DEFAULT)
  })

  it('re-exports from Geometry3D constants', () => {
    expect(geomConstants.RENDER_ORDER_DEFAULT).toBe(0)
    expect(geomConstants.RENDER_ORDER_EDITING).toBe(10)
    expect(geomConstants.RENDER_ORDER_HIGHLIGHT).toBe(999)
  })
})

describe('entityRenderLayer policy', () => {
  it('normal (no state) is depth-tested at the default layer', () => {
    expect(entityRenderLayer({})).toEqual({ depthTest: true, renderOrder: RENDER_ORDER_DEFAULT })
  })

  it('editing draws on top at the edit layer', () => {
    expect(entityRenderLayer({ isEditing: true })).toEqual({ depthTest: false, renderOrder: RENDER_ORDER_EDITING })
  })

  it('selected draws on top at the edit layer', () => {
    expect(entityRenderLayer({ selected: true })).toEqual({ depthTest: false, renderOrder: RENDER_ORDER_EDITING })
  })

  it('hovered overrides everything and rises to the highlight layer', () => {
    expect(entityRenderLayer({ hovered: true })).toEqual({ depthTest: false, renderOrder: RENDER_ORDER_HIGHLIGHT })
    expect(entityRenderLayer({ hovered: true, selected: true, isEditing: true }))
      .toEqual({ depthTest: false, renderOrder: RENDER_ORDER_HIGHLIGHT })
  })

  it('never returns undefined, so any state transition fully resets the layer', () => {
    // Deselect/unhover restoring to normal was the sticky-z bug: every result
    // must carry concrete depthTest + renderOrder values.
    for (const s of [{}, { isEditing: true }, { selected: true }, { hovered: true }]) {
      const layer = entityRenderLayer(s)
      expect(typeof layer.depthTest).toBe('boolean')
      expect(typeof layer.renderOrder).toBe('number')
    }
  })
})
