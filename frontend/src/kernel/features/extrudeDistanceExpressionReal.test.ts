// @vitest-environment node
//
// Gated real-OCC feature-level extrude tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Split from the original extrudeReal
// suite; shared spec builders live in extrudeRealSupport.ts. This file covers
// the math-expression distance resolver and the fusion of adjacent subdivided
// sketch regions.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import {
  oc, solveBytes, extrudeTestHarness, rectSketchSk, extrudeSpec, assertMeshBbox, vennBisectSpec,
} from './extrudeRealSupport'

describe.skipIf(!oc || !solveBytes)('extrude feature (real OCC + Rust solver): distance expressions and subdivided regions', () => {
  const h = extrudeTestHarness()

  // ─── Math-expression distance (kernel/evalExpr) ───

  it('extrude distance as an expression string resolves before solve', () => {
    // "20/4" must evaluate to 5 so the prism reaches z=5, exactly like a
    // plain numeric distance of 5.
    const spec = { features: [rectSketchSk('sk1', 10, 8), extrudeSpec('sk1', 'ex1', {})] }
    ;(spec.features[1] as Record<string, unknown>).distance = '20/4'
    const result = h.run(spec)
    expect(h.res(result, 'ex1').status).toBe('ok')
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 10], [0, 8], [0, 5])
  })

  it('adjacent subdivided regions fuse into one body', () => {
    /** Regression: segmented_surface_after_extrude. Four connected sketch regions
     *  extruded together must fuse into a single solid, not split into bodies. */
    const result = h.run(vennBisectSpec('add'))
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).not.toHaveProperty('body_ex1_1')
    expect(Object.keys(result.bodies)).toHaveLength(1)
    const mesh = h.body(result, 'body_ex1').mesh as {
      face_data?: Array<{ centroid: number[]; surface_type?: string }>
    } | undefined
    const fd = mesh?.face_data ?? []
    const topFlats = fd.filter((f) => f.surface_type === 'flatface' && Math.abs(f.centroid[2] - 10) < 0.1)
    expect(topFlats).toHaveLength(1)
  })

  it('adjacent regions selected individually fuse into one body', () => {
    /** Regression: segmented_surface_after_extrude. The four connected regions
     *  selected one by one (the user's exact order) must still fuse into one
     *  solid -- the extrude must not be order-sensitive. */
    const sketch = vennBisectSpec().features[0]
    const refs = [
      '?7,7,9,4;@sk1/cR@sk1/lnsurface:1@sk1:flatface',
      '?7,7,9,4;@sk1/cL@sk1/cRsurface:3@sk1:flatface',
      '?7,7,9,4;@sk1/cL@sk1/lnsurface:0@sk1:flatface',
      '?7,7,9,4;@sk1/cL@sk1/cRsurface:2@sk1:flatface',
    ]
    const result = h.run({
      features: [sketch, { id: 'ex1', kind: 'extrude', sketch: refs, distance: 10, direction: 'normal', operation: 'add' }],
    })
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).not.toHaveProperty('body_ex1_1')
    expect(Object.keys(result.bodies)).toHaveLength(1)
    // The swept top must be ONE planar face, not segmented per source region.
    const mesh = h.body(result, 'body_ex1').mesh as {
      face_data?: Array<{ centroid: number[]; surface_type?: string }>
    } | undefined
    const fd = mesh?.face_data ?? []
    const topFlats = fd.filter((f) => f.surface_type === 'flatface' && Math.abs(f.centroid[2] - 10) < 0.1)
    const botFlats = fd.filter((f) => f.surface_type === 'flatface' && Math.abs(f.centroid[2]) < 0.1)
    expect(topFlats).toHaveLength(1)
    expect(botFlats).toHaveLength(1)
  })

  it('invalid distance expression surfaces as a feature exception', () => {
    const spec = { features: [rectSketchSk('sk1', 10, 8), extrudeSpec('sk1', 'ex1', {})] }
    ;(spec.features[1] as Record<string, unknown>).distance = '2+/'
    const result = h.run(spec)
    expect(h.res(result, 'ex1').status).toBe('exception')
    expect(String(h.res(result, 'ex1').exception)).toContain('2+/')
  })
})
