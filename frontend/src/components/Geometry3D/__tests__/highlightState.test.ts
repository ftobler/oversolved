import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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

// The colour decision this feature removed: a hover that wins over a selection.
// Deliberately narrow, so the guard's claim matches what it can see:
// - `hovered`/`isHovered` and `selected`/`isSelected` both count;
// - the hovered branch must be a colour (a COLOR_ constant or a hex literal),
//   so a non-painter ternary such as `hovered ? 'grab' : selected ? 'move'`
//   is not mistaken for a painter;
// - newlines are allowed between the parts, so prettier's wrapped form is
//   caught as well as the one-line form.
// Other value kinds (a palette field, a material object) are out of its scope;
// the import check above is what covers those painters.
const HOVER_FIRST_PAINT = /\b(?:is)?[Hh]overed\b\s*\?\s*(?:COLOR_[A-Z0-9_]+|'#[0-9a-fA-F]{3,8}')(?:(?!\?)[\s\S]){0,160}?:\s*(?:is)?[Ss]elected\b\s*\?/

describe('hover-first paint detector', () => {
  it('matches the shapes this feature removed', () => {
    expect(HOVER_FIRST_PAINT.test(
      'const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : COLOR_INACTIVE')).toBe(true)
    expect(HOVER_FIRST_PAINT.test(
      'const color = hovered\n  ? COLOR_HOVER\n  : selected\n    ? COLOR_SELECTED\n    : COLOR_INACTIVE')).toBe(true)
    expect(HOVER_FIRST_PAINT.test(
      'const color = isHovered ? COLOR_HOVER : isSelected ? COLOR_SELECTED : base')).toBe(true)
    expect(HOVER_FIRST_PAINT.test(
      "const color = hovered ? '#ffffff' : selected ? COLOR_SELECTED : base")).toBe(true)
  })

  it('does not match non-painter or correctly ordered code', () => {
    expect(HOVER_FIRST_PAINT.test(
      "const cursor = hovered ? 'grab' : selected ? 'move' : 'default'")).toBe(false)
    expect(HOVER_FIRST_PAINT.test(
      'const color = selected ? COLOR_SELECTED : hovered ? COLOR_HOVER : base')).toBe(false)
    expect(HOVER_FIRST_PAINT.test(
      'const state = highlightState(selected, hovered)')).toBe(false)
    expect(HOVER_FIRST_PAINT.test(
      'const width = hovered ? 2 : 1')).toBe(false)
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
    ['Geometry3D', 'InferredContactMarkers.tsx'],
    ['Geometry3D', 'Constraints.tsx'],
    ['Viewport', 'HelixCurve.tsx'],
    ['Viewport', 'PlaneBody.tsx'],
    ['Viewport', 'OriginMarker.tsx'],
  ]

  const IMPORT = /import\s*\{[^}]*\bhighlightState\b[^}]*\}\s*from\s*'(?:@\/components\/Geometry3D\/constants|\.\/constants)'/

  for (const [dir, file] of PAINTERS) {
    it(`${dir}/${file} imports highlightState`, () => {
      const src = readFileSync(join(__dirname, '..', '..', dir, file), 'utf8')
      expect(src).toMatch(IMPORT)
    })
  }

  // The import check above cannot see a painter that imports the helper and
  // still writes its own order somewhere else. This scan is the backstop: it
  // walks the painter directories for the colour decision
  // `hovered ? COLOR : selected ? COLOR`, the exact ternary this feature
  // removed. The correct order puts the hovered branch last, so it does not
  // match, and the detector's own tests above pin what else it ignores.
  function sourceFiles(relativeDir: string): string[] {
    const root = join(__dirname, '..', '..', relativeDir)
    return readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('__tests__'))
      .map(f => join(root, f))
  }

  for (const dir of ['Geometry3D', 'Viewport']) {
    it(`${dir} paints no hover-first colour ternary`, () => {
      const offenders = sourceFiles(dir)
        .filter(file => HOVER_FIRST_PAINT.test(readFileSync(file, 'utf8')))
        .map(file => file.slice(file.indexOf('components')))
      expect(offenders).toEqual([])
    })
  }
})
