// Sketch area builder support for spline + full-ellipse entities
// (full-brep-projection follow-up). Input is the enriched per-entity geometry
// (enrichSketchEntity form): a full ellipse is a standalone closed area; a
// spline is an open edge chained into a loop by its endpoints.
import { describe, it, expect } from 'vitest'
import { detectTopology, topologyAvailable } from '../topologyTestUtil'

type Geom = Record<string, unknown>

describe.skipIf(!topologyAvailable)('detectTopology: full ellipse', () => {
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

  it('a degenerate ellipse (near-zero semi-axis) forms no area', () => {
    // A circle projected edge-on onto a perpendicular sketch plane collapses its
    // minor axis to ~0, lowering to a degenerate ellipse. It is geometrically a
    // line segment and bounds no area; emitting it as a fillable surface produces
    // a zero-area face that hangs the OCC boolean solver downstream (see
    // bugreports/document_not_loading_20260611_131446.md).
    const geometry: Geom = {
      e1: { kind: 'ellipse', center: [0, 20], a: 5, b: 0, theta: 0 },
    }
    const topo = detectTopology(geometry, 'sk')
    expect(topo.surfaces).toHaveLength(0)
  })
})

describe.skipIf(!topologyAvailable)('detectTopology: spline in a loop', () => {
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

  it('a self-closing spline (start == end) forms one standalone area', () => {
    // Bug: spline_self_loop. A single teardrop spline whose start and end both
    // sit on the origin should enclose one area. The DCEL skips it (its only
    // segment runs vertex->same vertex), so it is recovered as a standalone area.
    const geometry: Geom = {
      s1: {
        kind: 'spline',
        start: [0, 0],
        c1: [3.3431949615478516, 0],
        c2: [-0.13846899569034576, 2.643209934234619],
        end: [-1.073864813652368e-17, 1.2394294303993275e-14],
      },
    }
    const topo = detectTopology(geometry, 'sk')
    expect(topo.surfaces).toHaveLength(1)
    const boundary = topo.surfaces[0].boundary as Geom[]
    expect(boundary).toHaveLength(1)
    expect(boundary[0].kind).toBe('spline')
    expect(boundary[0].id).toBe('s1')
  })

  it('a self-closing spline cut by a chord splits into two areas', () => {
    // The companion bug: a chord through a closed spline divides it into two
    // selectable areas. The internal intersections cut the spline into sub-Beziers
    // that the DCEL traces as two faces, so this flows through the normal path.
    const geometry: Geom = {
      s1: {
        kind: 'spline',
        start: [0, 0],
        c1: [4, 4],
        c2: [-4, 4],
        end: [0, 0],
      },
      chord: { start: [-2, 1.5], end: [2, 1.5] },  // line cutting across the loop
    }
    const topo = detectTopology(geometry, 'sk')
    expect(topo.surfaces).toHaveLength(2)
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
