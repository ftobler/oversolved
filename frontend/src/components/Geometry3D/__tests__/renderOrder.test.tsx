import { describe, it, expect } from 'vitest'
import { RENDER_ORDER_DEFAULT, RENDER_ORDER_EDITING, RENDER_ORDER_HIGHLIGHT, RENDER_ORDER_SKETCH_FILL } from '@/utils/core/partColors'
import * as geomConstants from '@/components/Geometry3D/constants'
import { entityRenderLayer, dimensionRenderLayer, sketchFillRenderLayer } from '@/components/Geometry3D/constants'

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
    expect(geomConstants.RENDER_ORDER_SKETCH_FILL).toBe(-1)
  })
})

describe('entityRenderLayer policy', () => {
  it('normal (no state) is depth-tested at the default layer', () => {
    expect(entityRenderLayer({}))
      .toEqual({ depthTest: true, renderOrder: RENDER_ORDER_DEFAULT, transparent: true })
  })

  it('editing draws on top at the edit layer', () => {
    expect(entityRenderLayer({ isEditing: true }))
      .toEqual({ depthTest: false, renderOrder: RENDER_ORDER_EDITING, transparent: true })
  })

  it('selected draws on top at the edit layer', () => {
    expect(entityRenderLayer({ selected: true }))
      .toEqual({ depthTest: false, renderOrder: RENDER_ORDER_EDITING, transparent: true })
  })

  it('hovered rises to the highlight layer when nothing selects it', () => {
    expect(entityRenderLayer({ hovered: true }))
      .toEqual({ depthTest: false, renderOrder: RENDER_ORDER_HIGHLIGHT, transparent: true })
    expect(entityRenderLayer({ hovered: true, isEditing: true }))
      .toEqual({ depthTest: false, renderOrder: RENDER_ORDER_HIGHLIGHT, transparent: true })
  })

  it('selection outranks hover, so a selected+hovered entity stays at the edit layer', () => {
    expect(entityRenderLayer({ hovered: true, selected: true, isEditing: true }))
      .toEqual({ depthTest: false, renderOrder: RENDER_ORDER_EDITING, transparent: true })
    expect(entityRenderLayer({ hovered: true, selected: true }))
      .toEqual({ depthTest: false, renderOrder: RENDER_ORDER_EDITING, transparent: true })
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

describe('sketch fill layering', () => {
  // The fill polygon runs along the CENTRE of each boundary sketch line, so half
  // of every idle line's width sits under the fill. The two are therefore only
  // ordered correctly if both are in the sorted transparent pass AND the fill's
  // render order is strictly below every entity layer. Relying on one being
  // opaque and the other transparent is what split the lines lengthwise.
  const ENTITY_STATES = [
    {},
    { isEditing: true },
    { hinted: true },
    { hovered: true },
    { selected: true },
  ] as const

  it('keeps the fill below every entity layer', () => {
    const fill = sketchFillRenderLayer()
    expect(fill.renderOrder).toBe(RENDER_ORDER_SKETCH_FILL)
    expect(fill.renderOrder).toBeLessThan(RENDER_ORDER_DEFAULT)
    for (const state of ENTITY_STATES) {
      expect(fill.renderOrder).toBeLessThan(entityRenderLayer(state).renderOrder)
    }
  })

  it('puts both the fill and the entities in the transparent pass', () => {
    const fill = sketchFillRenderLayer()
    expect(fill.transparent).toBe(true)
    for (const state of ENTITY_STATES) {
      expect(entityRenderLayer(state).transparent).toBe(true)
    }
  })

  it('lets the fill hide behind solid geometry but never write depth', () => {
    // depthTest on: a body in front still occludes the fill. depthWrite off:
    // the fill must not cut the lines that are drawn after it at the same z.
    expect(sketchFillRenderLayer().depthTest).toBe(true)
    expect(sketchFillRenderLayer().depthWrite).toBe(false)
  })
})

describe('dimensionRenderLayer policy', () => {
  it('draws dimensions on the sketch edit layer with depth testing off', () => {
    expect(dimensionRenderLayer()).toEqual({ depthTest: false, renderOrder: RENDER_ORDER_EDITING })
  })

  it('sits strictly above the body layer, so a remounted body cannot sort over it', () => {
    expect(dimensionRenderLayer().renderOrder).toBeGreaterThan(RENDER_ORDER_DEFAULT)
  })
})
