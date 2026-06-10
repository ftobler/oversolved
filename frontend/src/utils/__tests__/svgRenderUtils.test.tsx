import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildSurfacePath, renderSketch, getEntityBounds } from '@/utils/core/svgRenderUtils'
import type { TopologySurface, Sketch, Ellipse } from '@/types/cad'

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
