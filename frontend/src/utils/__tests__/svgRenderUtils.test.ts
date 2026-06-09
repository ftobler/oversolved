import { describe, it, expect } from 'vitest'
import { buildSurfacePath } from '@/utils/core/svgRenderUtils'
import type { TopologySurface } from '@/types/cad'

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
})
