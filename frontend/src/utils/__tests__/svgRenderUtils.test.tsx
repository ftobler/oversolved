import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSurfacePath, renderSketch, getEntityBounds, renderConstraints } from '@/utils/core/svgRenderUtils'
import { COLOR_CONSTRAINT } from '@/utils/geometry/sketchHelpers'
import type { TopologySurface, Sketch, Ellipse, Constraints, ConstraintRender } from '@/types/cad'

const identity = (x: number, y: number): [number, number] => [x, y]

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  return {
    kind: 'arc' as const,
    center: [cx, cy] as [number, number],
    radius: r,
    angle_start_deg: a0,
    angle_end_deg: a1,
    ccw: true,
    start: [cx + r * Math.cos(a0 * Math.PI / 180), cy + r * Math.sin(a0 * Math.PI / 180)] as [number, number],
    end: [cx + r * Math.cos(a1 * Math.PI / 180), cy + r * Math.sin(a1 * Math.PI / 180)] as [number, number],
    start_vertex: null as unknown as string,
    end_vertex: null as unknown as string,
  }
}

describe('buildSurfacePath', () => {
  it('simple circle (2 semicircle arcs) produces one subpath', () => {
    const surface: TopologySurface = {
      query: 'q',
      boundary: [
        arc(0, 0, 2, 0, 180),
        arc(0, 0, 2, 180, 360),
      ],
    }
    const d = buildSurfacePath(surface, identity, 1)
    const mCount = (d.match(/\bM\b/g) ?? []).length
    const zCount = (d.match(/\bZ\b/g) ?? []).length
    expect(mCount).toBe(1)
    expect(zCount).toBe(1)
  })

  it('annulus (outer 2 arcs + inner 2 arcs) produces two subpaths', () => {
    const surface: TopologySurface = {
      query: 'q',
      boundary: [
        arc(0, 0, 5, 0, 180),
        arc(0, 0, 5, 180, 360),
        arc(0, 0, 2, 0, 180),
        arc(0, 0, 2, 180, 360),
      ],
    }
    const d = buildSurfacePath(surface, identity, 1)
    const mCount = (d.match(/\bM\b/g) ?? []).length
    const zCount = (d.match(/\bZ\b/g) ?? []).length
    expect(mCount).toBe(2)
    expect(zCount).toBe(2)
  })

  it('a line + spline loop emits a cubic-Bezier segment (not an arc)', () => {
    const surface = {
      query: 'q',
      boundary: [
        { kind: 'line', start: [0, 0], end: [4, 0] },
        { kind: 'spline', start: [4, 0], end: [0, 0], c1: [3, 3], c2: [1, 3] },
      ],
    } as unknown as TopologySurface
    const d = buildSurfacePath(surface, identity, 1)
    expect(d).toContain('C 3 3 1 3 0 0')  // control handles then the endpoint
    expect(d).not.toMatch(/NaN/)
    expect((d.match(/\bM\b/g) ?? []).length).toBe(1)
    expect((d.match(/\bZ\b/g) ?? []).length).toBe(1)
  })

  it('a full ellipse renders a closed two-arc sub-path (no crash, no NaN)', () => {
    const surface = {
      query: 'q',
      boundary: [
        { kind: 'ellipse', center: [3, 1], a: 4, b: 2, theta: 0, start_vertex: null, end_vertex: null, id: 'e1' },
      ],
    } as unknown as TopologySurface
    const d = buildSurfacePath(surface, identity, 1)
    expect(d).not.toMatch(/NaN/)
    expect((d.match(/\bM\b/g) ?? []).length).toBe(1)
    expect((d.match(/\bA\b/g) ?? []).length).toBe(2)  // two half-ellipse arcs
    expect((d.match(/\bZ\b/g) ?? []).length).toBe(1)
  })
})

describe('renderSketch ellipse arm', () => {
  // px flips y (screen space), so a sketch CCW rotation must render as a screen
  // CW rotation: the transform negates theta. Pin that sign here.
  it('emits an <ellipse> with scaled rx/ry and a negated rotation', () => {
    const sketch: Sketch = { e1: { center: [1, 2], a: 4, b: 2, theta: 30 } as Ellipse }
    const html = renderToStaticMarkup(
      <svg>{renderSketch(sketch, identity, 2, () => '#fff', 1)}</svg>
    )
    expect(html).toContain('<ellipse')
    expect(html).toMatch(/rx="8"/)   // a=4 * pxScale=2
    expect(html).toMatch(/ry="4"/)   // b=2 * pxScale=2
    // y-flip: rotate(-theta cx cy) with cx,cy = identity(1,2)
    expect(html).toContain('rotate(-30 1 2)')
  })

  it('renders a construction ellipse dashed', () => {
    const sketch: Sketch = { e1: { center: [0, 0], a: 3, b: 1, theta: 0, construction: true } as Ellipse }
    const html = renderToStaticMarkup(
      <svg>{renderSketch(sketch, identity, 1, () => '#fff', 1)}</svg>
    )
    expect(html).toMatch(/stroke-dasharray="4 2"/)
  })
})

describe('renderConstraints dimension labels', () => {
  // Every dimension kind stamps the same label plate through one helper. The
  // formulas below are the contract: a plate centred on the text anchor and wide
  // enough for the monospace glyphs it backs. dim_angle used to estimate 3px per
  // char, which left decimal labels hanging out of their own background.
  const CHAR_WIDTH = 5
  const PADDING = 3
  const HEIGHT = 12
  const FONT_SIZE = 9
  // What the estimate is approximating: Roboto Mono advances 0.6em per glyph, so
  // a label really occupies label.length * 5.4px at FONT_SIZE.
  const GLYPH_ADVANCE = FONT_SIZE * 0.6

  // Every dim render needs an `entity` that exists in the sketch, or
  // renderConstraints skips the whole group before it reaches a dimension.
  const sketch: Sketch = { l1: { start: [0, 0], end: [10, 0] } as Sketch[string] }

  function labelGroup(render: ConstraintRender): Element {
    const constraints: Constraints = { c1: { render, residual: 0 } }
    const html = renderToStaticMarkup(
      <svg>{renderConstraints(constraints, sketch, identity, 1, () => undefined)}</svg>
    )
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // Dimension groups carry opacity 0.85; symbol groups do not, and would
    // otherwise be picked up first by whoever extends this block.
    const g = doc.querySelector('g[opacity="0.85"]')
    expect(g).not.toBeNull()
    return g!
  }

  function plateOf(g: Element) {
    const rects = g.querySelectorAll('rect')
    const texts = g.querySelectorAll('text')
    expect(rects.length).toBe(1)  // one plate per dimension, not one per element
    expect(texts.length).toBe(1)
    const [rect, text] = [rects[0], texts[0]]
    const num = (el: Element, a: string) => Number(el.getAttribute(a))
    return {
      label: text.textContent ?? '',
      x: num(rect, 'x'), y: num(rect, 'y'),
      width: num(rect, 'width'), height: num(rect, 'height'),
      fill: rect.getAttribute('fill'),
      textX: num(text, 'x'), textY: num(text, 'y'),
      textFill: text.getAttribute('fill'),
      fontFamily: text.getAttribute('font-family'),
      fontSize: num(text, 'font-size'),
      anchor: text.getAttribute('text-anchor'),
      baseline: text.getAttribute('dominant-baseline'),
    }
  }

  function expectSharedPlate(g: Element) {
    const p = plateOf(g)
    expect(p.width).toBe(p.label.length * CHAR_WIDTH + PADDING * 2)
    expect(p.height).toBe(HEIGHT)
    expect(p.x).toBeCloseTo(p.textX - p.width / 2)  // centred on the anchor
    expect(p.y).toBeCloseTo(p.textY - HEIGHT / 2)
    expect(p.fill).toBe('#111')
    expect(p.textFill).toBe(COLOR_CONSTRAINT)
    expect(p.fontFamily).toBe('Roboto Mono, monospace')
    // The centring above is a relation between plate and text; it says nothing
    // about the glyph size the plate was sized for, nor about the text actually
    // being centred on the anchor point the branch computed.
    expect(p.fontSize).toBe(FONT_SIZE)
    expect(p.anchor).toBe('middle')
    expect(p.baseline).toBe('middle')
    return p
  }

  const linear: ConstraintRender = {
    kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10, entity: 'l1',
  }
  const radius: ConstraintRender = {
    kind: 'dim_radius', p1: [0, 0], p2: [4, 0], value: 2.5, entity: 'l1',
  }
  // Deliberately NOT a right angle: with equal leg directions the label lands on
  // the arc bisector at labelX === labelY, and a swapped x/y at the call site
  // would be unobservable.
  const angle: ConstraintRender = {
    kind: 'dim_angle', p1: [0, 0], p2: [10, 0], p3: [0, 0], p4: [10, 10], value: 45.5, entity: 'l1',
  }

  it('dim_linear stamps its plate at the dimension-line midpoint', () => {
    const p = expectSharedPlate(labelGroup(linear))
    expect(p.label).toBe('10')
    // offset = 14 * pxScale / max(pxScale, 1) + 10 = 24 at pxScale 1, along +y.
    expect(p.textX).toBeCloseTo(5)
    expect(p.textY).toBeCloseTo(24)
  })

  it('dim_radius stamps its plate at the midpoint of the 10deg-rotated leader', () => {
    const p = expectSharedPlate(labelGroup(radius))
    expect(p.label).toBe('R2.50')  // radius formats to 2 decimals
    const rad = 10 * (Math.PI / 180)
    expect(p.textX).toBeCloseTo((4 * Math.cos(rad)) / 2)
    expect(p.textY).toBeCloseTo((4 * Math.sin(rad)) / 2)
  })

  it('dim_angle stamps its plate outside the arc, on the bisector', () => {
    const p = expectSharedPlate(labelGroup(angle))
    expect(p.label).toBe('45.5°')
    // arcRadius = min(rA, rB) * 0.4 = 4; the label sits at 1.5x that, halfway
    // between the two leg directions (0 and 45deg).
    const labelRadius = 4 * 1.5
    expect(p.textX).toBeCloseTo(labelRadius * Math.cos(Math.PI / 8))
    expect(p.textY).toBeCloseTo(labelRadius * Math.sin(Math.PI / 8))
    expect(p.textX).not.toBeCloseTo(p.textY)  // the fixture stays asymmetric
  })

  it('a long angle label fits inside its own plate', () => {
    // 6 chars is where the old 3px-per-char angle estimate broke: 30px of plate
    // behind 32.4px of glyphs. The shared estimate gives 36.
    const p = plateOf(labelGroup({ ...angle, value: 100.5 } as ConstraintRender))
    expect(p.label).toBe('100.5°')
    expect(p.width).toBeGreaterThanOrEqual(p.label.length * GLYPH_ADVANCE)
  })

  it('all three kinds derive the plate from the same formula', () => {
    const plates = [linear, radius, angle].map(r => plateOf(labelGroup(r)))
    const perChar = plates.map(p => (p.width - PADDING * 2) / p.label.length)
    expect(perChar).toEqual([CHAR_WIDTH, CHAR_WIDTH, CHAR_WIDTH])
    expect(plates.map(p => p.height)).toEqual([HEIGHT, HEIGHT, HEIGHT])
  })
})

describe('getEntityBounds ellipse', () => {
  it('axis-aligned bounds use the semi-axes (screen space via px)', () => {
    const el: Ellipse = { center: [1, 2], a: 4, b: 2, theta: 0 }
    const b = getEntityBounds(el, identity)!
    expect(b.minX).toBeCloseTo(-3)
    expect(b.maxX).toBeCloseTo(5)
    expect(b.minY).toBeCloseTo(0)
    expect(b.maxY).toBeCloseTo(4)
  })

  it('90deg rotation swaps the extents', () => {
    const el: Ellipse = { center: [0, 0], a: 4, b: 2, theta: 90 }
    const b = getEntityBounds(el, identity)!
    expect(b.maxX).toBeCloseTo(2)
    expect(b.maxY).toBeCloseTo(4)
  })
})
