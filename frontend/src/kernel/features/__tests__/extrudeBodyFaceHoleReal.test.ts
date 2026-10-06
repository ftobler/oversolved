// @vitest-environment node
//
// Gated real-OCC feature-level extrude tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Split from the original extrudeReal
// suite; the shared harness lives in extrudeRealSupport.ts. This file is the
// hole-seam regression group: extruding a body face that carries a hole and
// adding it back onto itself.
//
// Reproduces bugreports/extrude_2_does_not_work and extrude_2_mangled_hole.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { type BuildResponse } from '../../builder'
import { oc, solveBytes, extrudeTestHarness } from '../extrudeRealSupport'

describe.skipIf(!oc || !solveBytes)('extrude feature (real OCC + Rust solver): body face with a hole added back', () => {
  const h = extrudeTestHarness()

  // ─── Extrude a body face that has a hole, added back onto itself ───

  // A first extrude of a peanut profile (two overlapping circles) with a hole
  // leaves a body whose top face carries an inner loop. Extruding that face with
  // the default `add` operation fuses the new prism onto the same body across
  // their shared coincident face. The fuse itself is a valid solid, but a naive
  // coplanar-merge would leave every wall (including the hole cylinder) split
  // at the profile plane into two faces, since the emergent hole cylinder of
  // the multi-surface ex1 carries a non-canonical seam while the tool (a prism
  // of the canonical hole edge on the body's top face) carries seam 0. The
  // pre-prism profile union canonicalizes the body's hole cylinder so the
  // add-fuse merges cleanly and the body keeps exactly the continuous set:
  // top + bottom + 2 outer walls + 1 hole wall = 5 faces, NOT 8.
  const peanutWithHoleSketch = {
    id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
    entities: [
      { id: 'cL', kind: 'circle' }, { id: 'cR', kind: 'circle' },
      { id: 'ln', kind: 'line' }, { id: 'pTop', kind: 'point' }, { id: 'pBot', kind: 'point' },
      { id: 'cHole', kind: 'circle' },
    ],
    initial: {
      cL: [-6.614378452301025, 7.5, 10], cR: [6.614378452301025, 7.5, 10],
      ln: [0, 15, 0, 0], pTop: [0, 15], pBot: [0, 0],
      cHole: [-6.614378452301025, 7.5, 5.703681945800781],
    },
    constraints: [
      { id: 'eq', kind: 'equal_length', a: '$cR', b: '$cL' },
      { id: 'co1', kind: 'coincident', a: '$pTopxy', b: '$cL' },
      { id: 'co2', kind: 'coincident', a: '$pTopxy', b: '$cR' },
      { id: 'co3', kind: 'coincident', a: '$lnstart', b: '$pTopxy' },
      { id: 'co4', kind: 'coincident', a: '$pBotxy', b: '$cL' },
      { id: 'co5', kind: 'coincident', a: '$pBotxy', b: '$cR' },
      { id: 'co6', kind: 'coincident', a: '$lnend', b: '$pBotxy' },
      { id: 'vert', kind: 'vertical', target: '$ln' },
      { id: 'co7', kind: 'coincident', a: '@builtin_origin', b: '$pBotxy' },
      { id: 'len', kind: 'length', target: '$ln', value: 15 },
      { id: 'dia', kind: 'diameter', target: '$cR', value: 20 },
      { id: 'coHole', kind: 'coincident', a: '$cHolecenter', b: '$cLcenter' },
    ],
  }

  function sk1SurfaceQueries(): string[] {
    const r = h.run({ features: [peanutWithHoleSketch] })
    const state = r._build_state as unknown as { checkpoints: Record<string, { repo_snapshot: { elements: Record<string, unknown> } }> }
    const cp = Object.values(state.checkpoints)[0]
    const topo = cp?.repo_snapshot?.elements?.['_topo_sk1'] as { surfaces?: Array<{ query?: string }> } | undefined
    return (topo?.surfaces ?? []).map((s) => s.query ?? '')
  }

  function topFaceQuery(result: BuildResponse, bodyId: string): string {
    // Both `normal[2] > 0.9` AND `surface_type === 'flatface'` -- a fillet's
    // arc face can have a near-vertical normal at parts of its swept arc,
    // which would otherwise grab a fillet face instead of the flat cap.
    const mesh = h.body(result, bodyId).mesh as { face_data?: Array<{ normal: number[]; surface_type?: string }>; face_queries?: string[] } | undefined
    let q = ''
    mesh?.face_data?.forEach((fd, i) => { if (fd.normal[2] > 0.9 && fd.surface_type === 'flatface') q = mesh.face_queries?.[i] ?? '' })
    return q
  }

  it('extrude of a body face with a hole, add operation, does not fail', () => {
    const surfs = sk1SurfaceQueries()
    // Extrude only the four ring surfaces (0..3), excluding the hole disk (4,5),
    // so the resulting body keeps a hole through it.
    const profile = surfs.slice(0, 4)
    const first = h.run({
      features: [
        peanutWithHoleSketch,
        { id: 'ex1', kind: 'extrude', sketch: profile, distance: 10, direction: 'normal' },
      ],
    })
    expect(h.res(first, 'ex1').status).toBe('ok')
    const topQuery = topFaceQuery(first, 'body_ex1')
    expect(topQuery).not.toBe('')

    const result = h.run({
      features: [
        peanutWithHoleSketch,
        { id: 'ex1', kind: 'extrude', sketch: profile, distance: 10, direction: 'normal' },
        { id: 'ex2', kind: 'extrude', sketch: topQuery, distance: 10, direction: 'normal' },  // default add
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as { vertices: number[][]; face_data?: unknown[] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      const zs = mesh.vertices.map((v) => v[2])
      expect(Math.min(...zs)).toBeCloseTo(0, 5)
      expect(Math.max(...zs)).toBeCloseTo(20, 5)  // both extrudes fused into one 20-tall body
      // The hole survives: an inner cylindrical wall means faces beyond the bare
      // top/bottom/outer-wall set of a hole-less solid.
      expect((mesh.face_data ?? []).length).toBeGreaterThan(4)
    }
  })

  it('add of a hole-bearing top face yields continuous B-rep (no seam at the profile plane)', () => {
    /** Regression for the seam-left-by-the-add defect: with the pre-prism
     *  profile union, the body's hole cylinder carries the canonical seam so
     *  the add-fuse onto it merges cleanly. The fused body must have exactly
     *  5 continuous faces (top + bottom + 2 outer walls + 1 hole wall), NOT
     *  8 (each wall split at z=10). The hole cylinder must be a single face
     *  spanning z 0..20. */
    const surfs = sk1SurfaceQueries()
    const profile = surfs.slice(0, 4)
    const first = h.run({
      features: [
        peanutWithHoleSketch,
        { id: 'ex1', kind: 'extrude', sketch: profile, distance: 10, direction: 'normal' },
      ],
    })
    expect(h.res(first, 'ex1').status).toBe('ok')
    const topQuery = topFaceQuery(first, 'body_ex1')
    expect(topQuery).not.toBe('')

    const result = h.run({
      features: [
        peanutWithHoleSketch,
        { id: 'ex1', kind: 'extrude', sketch: profile, distance: 10, direction: 'normal' },
        { id: 'ex2', kind: 'extrude', sketch: topQuery, distance: 10, direction: 'normal' },
      ],
    })
    expect(h.res(result, 'ex2').status).toBe('ok')

    const mesh = h.body(result, 'body_ex1').mesh as {
      face_data?: Array<{ centroid: number[]; normal: number[]; surface_type?: string }>
    } | undefined
    const fd = mesh?.face_data ?? []
    expect(fd).toHaveLength(5)
    // Two flat faces: top (normal +Z at z=20) and bottom (normal -Z at z=0).
    const topFlats = fd.filter((f) => f.surface_type === 'flatface' && f.normal[2] > 0.9)
    const botFlats = fd.filter((f) => f.surface_type === 'flatface' && f.normal[2] < -0.9)
    expect(topFlats).toHaveLength(1)
    expect(botFlats).toHaveLength(1)
    expect(topFlats[0].centroid[2]).toBeCloseTo(20, 0)
    expect(botFlats[0].centroid[2]).toBeCloseTo(0, 0)
    // Three cylinder faces: 2 outer walls (cL and cR partial arcs) + 1 hole wall.
    const cyls = fd.filter((f) => f.surface_type === 'cylinderface')
    expect(cyls).toHaveLength(3)
    // The hole wall: a cylinder centered on cHole's center (cL's center,
    // -6.614 x) at the hole radius 5.7037, spanning the full 0..20 height --
    // i.e. its centroid is at z=10 (the midpoint), not at 5 or 15 (the seam).
    // Center near [-6.614, 7.5, *], radius ~5.7037, centroid z ~ 10.
    const hole = cyls.find((c) => Math.abs(c.centroid[0] - (-6.614378452301025)) < 0.5 && Math.abs(c.centroid[1] - 7.5) < 0.5)
    expect(hole).toBeDefined()
    expect(hole!.centroid[2]).toBeCloseTo(10, 0)  // spans full 0..20, not split at the z=10 seam
    // The two outer walls (cL outer arc + cR outer arc): one centered far-left
    // of cL, one far-right of cR -- each spans full 0..20 too.
    const outerWalls = cyls.filter((c) => c !== hole)
    expect(outerWalls).toHaveLength(2)
    for (const w of outerWalls) {
      expect(w.centroid[2]).toBeCloseTo(10, 0)
    }
  })

  it('fillet before the add-of-a-hole-face keeps continuous B-rep (no seam)', () => {
    /** The reproducer ex2_mangled_hole: ex1 -> fillet the two lobe-intersection
     *  vertical edges -> extrude 2 add the top face. The fillet adds two more
     *  faces that would ALSO split at the seam; the pre-prism union keeps them
     *  continuous too. Asserts exactly ONE hole wall across z 0..20 (no seam
     *  face at z=10), and the assembled solid spans z 0..20. */
    const surfs = sk1SurfaceQueries()
    const profile = surfs.slice(0, 4)
    // First pass: build ex1 (no fillet yet); grab its two vertical
    // lobe-intersection edge queries so the fillet can target them.
    const r1 = h.run({
      features: [
        peanutWithHoleSketch,
        { id: 'ex1', kind: 'extrude', sketch: profile, distance: 10, direction: 'normal' },
      ],
    })
    expect(h.res(r1, 'ex1').status).toBe('ok')
    const edgeQueries = (h.body(r1, 'body_ex1').edge_queries as string[]) ?? []
    const edges = (h.body(r1, 'body_ex1').edges as Array<{ kind?: string; start?: number[]; end?: number[]; center?: number[]; radius?: number }>) ?? []
    // The two vertical edges at the intersections of cL and cR (the lobe seam).
    // Their endpoints sit on x=0 (the vertical line `ln`) and span z=0..10,
    // additionally distinguishing the two edges by their y-intersection-point
    // (one at y ~= 0, one at y ~= 15).  Tighten the heuristic so a later edge
    // reorder / tessellation tweak does not silently rebind the fillet to the
    // wrong pair: assert z ~ 0/10 endpoints AND distinct y endpoints.
    const vertEdgeIndex: number[] = []
    for (let i = 0; i < edges.length && vertEdgeIndex.length < 2; i++) {
      const e = edges[i]
      const s = e.start ?? [0, 0, 0]
      const en = e.end ?? [0, 0, 0]
      const vertical = Math.abs(s[0] - en[0]) < 1e-3 && Math.abs(s[1] - en[1]) < 1e-3 && Math.abs(s[2] - en[2]) > 1
      const onLensLine = Math.abs((s[0] + en[0]) / 2) < 0.2  // x ~= 0 (the line `ln`)
      const spansBody = Math.min(s[2], en[2]) < 1e-2 && Math.max(s[2], en[2]) > 10 - 1e-2  // z 0..10
      if (vertical && onLensLine && spansBody) vertEdgeIndex.push(i)
    }
    // The fillet must actually run -- if the edges cannot be located the test
    // is meaningless, so fail loudly rather than silently skip.
    expect(vertEdgeIndex).toHaveLength(2)
    const filletEdges = vertEdgeIndex.map((i) => edgeQueries[i]).filter((q) => !!q)
    expect(filletEdges).toHaveLength(2)
    // The two distinct vertical lobe-intersection edges sit at y ~= 0 and
    // y ~= 15 (the pBot / pTop intersection points); bind them to that too.
    const yMids = vertEdgeIndex.map((i) => {
      const s = edges[i].start ?? [0, 0, 0]
      const e = edges[i].end ?? [0, 0, 0]
      return (s[1] + e[1]) / 2
    })
    const ySorted = [...yMids].sort((a, b) => a - b)
    // The two distinct vertical lobe-intersection edges must bind to the two
    // lobe y positions, one below and one above the midline.
    expect(ySorted[0]).toBeLessThan(7.5)
    expect(ySorted[1]).toBeGreaterThanOrEqual(7.5)
    expect(ySorted[0]).toBeCloseTo(0, 0)
    expect(ySorted[1]).toBeCloseTo(15, 0)

    // Find a flat top-face query from r1 (for ex2's profile).
    const topQuery = topFaceQuery(r1, 'body_ex1')
    expect(topQuery).not.toBe('')

    const spec2 = {
      features: [
        peanutWithHoleSketch,
        { id: 'ex1', kind: 'extrude', sketch: profile, distance: 10, direction: 'normal' },
        { id: 'fil1', kind: 'fillet', edges: filletEdges, radius: 0.5 },
        { id: 'ex2', kind: 'extrude', sketch: topQuery, distance: 10, direction: 'normal' },
      ],
    }
    const result = h.run(spec2)
    expect(h.res(result, 'ex2').status).toBe('ok')
    const m2 = h.body(result, 'body_ex1').mesh as {
      face_data?: Array<{ centroid: number[]; normal: number[]; surface_type?: string }>
    } | undefined
    const fd = m2?.face_data ?? []
    // The hole cylinder must remain ONE face across the full z extent -- no
    // seam split at z=10. Multiple outer/fillet faces are expected, but no
    // hole cylinder face is allowed at z=10 (centroid near z=5 or z=15 only).
    const holeCyls = fd.filter(
      (f) => f.surface_type === 'cylinderface' &&
        Math.abs(f.centroid[0] - (-6.614378452301025)) < 0.5 &&
        Math.abs(f.centroid[1] - 7.5) < 0.5,
    )
    // Exactly one hole cylinder face across z 0..20 (centroid at z=10), not
    // two split at the seam (which would land at z=5 and z=15).
    expect(holeCyls).toHaveLength(1)
    expect(holeCyls[0].centroid[2]).toBeCloseTo(10, 0)
  })
})
