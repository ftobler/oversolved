import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { highlightState, entityRenderLayer, RENDER_ORDER_EDITING, RENDER_ORDER_HIGHLIGHT } from '@/components/Geometry3D/constants'

/**
 * Hover and selection have to agree on which one wins. They used to each carry
 * their own ternary (`hovered ? HOVER : selected ? SELECTED` in the sketch
 * painters, the opposite order in the B-rep overlays and sketch areas), so the
 * same primitive could read two colours depending on which layer drew it. The
 * shared rule below is selection first; this suite pins the table and, with the
 * grep guard, that every painter actually asks it.
 */

describe('highlightState precedence', () => {
  it('selection outranks hover', () => {
    expect(highlightState(true, true)).toBe('selected')
  })

  it('a lone highlight keeps its own state', () => {
    expect(highlightState(true, false)).toBe('selected')
    expect(highlightState(false, true)).toBe('hovered')
  })

  it('nothing highlighted is null', () => {
    expect(highlightState(false, false)).toBeNull()
  })
})

describe('entityRenderLayer follows the same precedence', () => {
  it('a hovered entity rises to the highlight layer', () => {
    expect(entityRenderLayer({ hovered: true })).toEqual({
      depthTest: false, renderOrder: RENDER_ORDER_HIGHLIGHT,
    })
  })

  it('a selected entity stays at the edit layer even while hovered', () => {
    expect(entityRenderLayer({ selected: true, hovered: true })).toEqual({
      depthTest: false, renderOrder: RENDER_ORDER_EDITING,
    })
  })

  it('editing still lifts a hovered entity, and a selected one outranks editing', () => {
    expect(entityRenderLayer({ isEditing: true, hovered: true })).toEqual({
      depthTest: false, renderOrder: RENDER_ORDER_HIGHLIGHT,
    })
    expect(entityRenderLayer({ isEditing: true, selected: true, hovered: true })).toEqual({
      depthTest: false, renderOrder: RENDER_ORDER_EDITING,
    })
  })
})

describe('every painter imports the one precedence helper', () => {
  // Relative to this test file. A painter that decides its own hover-vs-select
  // order is the bug this feature exists to remove, so the guard is on the
  // import itself, not on any particular call shape.
  const PAINTERS = [
    ['Geometry3D', 'EntityLines.tsx'],
    ['Geometry3D', 'VertexDots.tsx'],
    ['Geometry3D', 'Surfaces.tsx'],
    ['Geometry3D', 'highlightOverlay.tsx'],
    ['Geometry3D', 'vertexInstancePainter.ts'],
    ['Geometry3D', 'highlightColorPainter.ts'],
    ['Viewport', 'HelixCurve.tsx'],
    ['Viewport', 'PlaneBody.tsx'],
  ]

  const IMPORT = /import\s*\{[^}]*\bhighlightState\b[^}]*\}\s*from\s*'(?:@\/components\/Geometry3D\/constants|\.\/constants)'/

  for (const [dir, file] of PAINTERS) {
    it(`${dir}/${file} imports highlightState`, () => {
      const src = readFileSync(join(__dirname, '..', '..', dir, file), 'utf8')
      expect(src).toMatch(IMPORT)
    })
  }
})
