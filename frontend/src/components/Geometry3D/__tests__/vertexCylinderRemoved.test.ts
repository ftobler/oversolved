import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * 267.6 / 267.7: The raycaster-era vertex-hit cylinder geometry in
 * HitPolyline is gone. Vertex picking now lives in the screen-space
 * fattened vertex ID layer.
 *
 * 274: All raycaster hit meshes removed from VertexDots. Only visual
 * circleGeometry remains (the Dot component). No sphereGeometry left.
 */

const VERTEX_DOTS = join(__dirname, '..', 'VertexDots.tsx')

describe('vertex cylinder hack is removed', () => {
  const src = readFileSync(VERTEX_DOTS, 'utf8')

  it('VertexDots.tsx has no cylinderGeometry', () => {
    expect(src).not.toContain('cylinderGeometry')
  })

  it('VertexDots.tsx has no HitPolyline component', () => {
    expect(src).not.toContain('export function HitPolyline')
    expect(src).not.toContain('HitPolyline')
  })

  it('VertexDots.tsx vertex hit zones use sphereGeometry only', () => {
    const geos = src.match(/<(\w+)Geometry\b/g) ?? []
    // Should only contain sphereGeometry and circleGeometry (for Dot).
    const nonSphere = geos.filter(g => g !== '<sphereGeometry' && g !== '<circleGeometry')
    expect(nonSphere, `unexpected geometry types: ${nonSphere.join(', ')}`).toEqual([])
  })
})
