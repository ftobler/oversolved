// Sketch area builder support for spline + full-ellipse entities
// (full-brep-projection follow-up). Input is the enriched per-entity geometry
// (enrichSketchEntity form): a full ellipse is a standalone closed area; a
// spline is an open edge chained into a loop by its endpoints.
import { describe, it, expect } from 'vitest'
import { detectTopology } from './topology'

type Geom = Record<string, unknown>

describe('detectTopology: full ellipse', () => {
  it('a single full ellipse forms one standalone area', () => {
    const geometry: Geom = {
      e1: { kind: 'ellipse', center: [0, 0], a: 4, b: 2, theta: 0 },
    }
    const topo = detectTopology(geometry, 'sk')
    expect(topo.surfaces).toHaveLength(1)
    const boundary = topo.surfaces[0].boundary as Geom[]
    expect(boundary).toHaveLength(1)
    expect(boundary[0].kind).toBe('ellipse')
    expect(boundary[0].a).toBe(4)
    expect(boundary[0].b).toBe(2)
    expect(boundary[0].id).toBe('e1')
  })
})

describe('detectTopology: spline in a loop', () => {
  it('a line + spline sharing both endpoints close into one area', () => {
    // D-shape: line A->B along the base, spline B->A bulging up.
    const A = [0, 0]
    const B = [4, 0]
    const geometry: Geom = {
      base: { start: A, end: B },  // line
      arc: { kind: 'spline', start: B, end: A, c1: [3, 3], c2: [1, 3] },
    }
    const topo = detectTopology(geometry, 'sk')
    expect(topo.surfaces).toHaveLength(1)
    const kinds = (topo.surfaces[0].boundary as Geom[]).map((e) => e.kind)
    expect(kinds).toContain('line')
    expect(kinds).toContain('spline')
  })

  it('an open spline with no closing edge forms no area', () => {
    const geometry: Geom = {
      s1: { kind: 'spline', start: [0, 0], end: [4, 0], c1: [1, 2], c2: [3, 2] },
    }
    const topo = detectTopology(geometry, 'sk')
    expect(topo.surfaces).toHaveLength(0)
  })

  it('two splines sharing both endpoints close into one area (lens)', () => {
    const A = [0, 0]
    const B = [4, 0]
    const geometry: Geom = {
      top: { kind: 'spline', start: A, end: B, c1: [1, 2], c2: [3, 2] },
      bot: { kind: 'spline', start: B, end: A, c1: [3, -2], c2: [1, -2] },
    }
    const topo = detectTopology(geometry, 'sk')
    expect(topo.surfaces).toHaveLength(1)
    const kinds = (topo.surfaces[0].boundary as Geom[]).map((e) => e.kind)
    expect(kinds.every((k) => k === 'spline')).toBe(true)
  })
})
