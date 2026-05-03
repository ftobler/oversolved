import { describe, it, expect } from 'vitest'
import { RENDER_ORDER_DEFAULT, RENDER_ORDER_GHOST, RENDER_ORDER_EDITING, RENDER_ORDER_HIGHLIGHT } from '../../../utils/partColors'
import * as geomConstants from '../constants'

describe('render order constants', () => {
  it('defines RENDER_ORDER_DEFAULT as 0', () => {
    expect(RENDER_ORDER_DEFAULT).toBe(0)
  })

  it('defines RENDER_ORDER_GHOST as 1', () => {
    expect(RENDER_ORDER_GHOST).toBe(1)
  })

  it('defines RENDER_ORDER_EDITING as 10', () => {
    expect(RENDER_ORDER_EDITING).toBe(10)
  })

  it('defines RENDER_ORDER_HIGHLIGHT as 999', () => {
    expect(RENDER_ORDER_HIGHLIGHT).toBe(999)
  })

  it('editing > default and ghost', () => {
    expect(RENDER_ORDER_EDITING).toBeGreaterThan(RENDER_ORDER_DEFAULT)
    expect(RENDER_ORDER_EDITING).toBeGreaterThan(RENDER_ORDER_GHOST)
  })

  it('highlight > all others', () => {
    expect(RENDER_ORDER_HIGHLIGHT).toBeGreaterThan(RENDER_ORDER_EDITING)
    expect(RENDER_ORDER_HIGHLIGHT).toBeGreaterThan(RENDER_ORDER_GHOST)
    expect(RENDER_ORDER_HIGHLIGHT).toBeGreaterThan(RENDER_ORDER_DEFAULT)
  })

  it('re-exports from Geometry3D constants', () => {
    expect(geomConstants.RENDER_ORDER_DEFAULT).toBe(0)
    expect(geomConstants.RENDER_ORDER_GHOST).toBe(1)
    expect(geomConstants.RENDER_ORDER_EDITING).toBe(10)
    expect(geomConstants.RENDER_ORDER_HIGHLIGHT).toBe(999)
  })
})
