// @vitest-environment node
//
// Gated real-OCC feature-level extrude tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Split from the original extrudeReal
// suite; shared spec builders live in extrudeRealSupport.ts. This file covers
// the editing handle descriptor an extrude emits for the viewport.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { type BuildResponse } from '../builder'
import {
  oc, solveBytes, extrudeTestHarness, rectSketchSk, fullRectExtrudeSpec, assertMeshBbox,
} from './extrudeRealSupport'

describe.skipIf(!oc || !solveBytes)('extrude feature (real OCC + Rust solver): editing handle descriptor', () => {
  const h = extrudeTestHarness()

  // ─── Editing handle descriptor ───

  function handleOf(result: BuildResponse, featureId: string): Record<string, unknown> {
    const handle = h.res(result, featureId).handle as Record<string, unknown> | undefined
    expect(handle).toBeDefined()
    return handle!
  }

  function expectVecClose(v: unknown, expected: number[]): void {
    const arr = v as number[]
    expect(arr).toHaveLength(expected.length)
    for (let i = 0; i < expected.length; i++) expect(arr[i]).toBeCloseTo(expected[i], 4)
  }

  it('blind extrude emits a linear distance handle at the swept face centroid', () => {
    const result = h.run(fullRectExtrudeSpec(10, 10, 5))
    const handle = handleOf(result, 'ex1')
    expect(handle.kind).toBe('linear')
    expect(handle.field).toBe('distance')
    expect(handle.value).toBe(5)
    expect(handle.unit_scale).toBe(1)
    expectVecClose(handle.direction, [0, 0, 1])
    expectVecClose(handle.anchor, [5, 5, 5])
  })

  it('reverse extrude handle points the other way', () => {
    const result = h.run(fullRectExtrudeSpec(10, 10, 5, 'reverse'))
    const handle = handleOf(result, 'ex1')
    expectVecClose(handle.direction, [0, 0, -1])
    expectVecClose(handle.anchor, [5, 5, -5])
  })

  it('symmetric extrude handle grabs the half-distance face at half scale', () => {
    const result = h.run(fullRectExtrudeSpec(10, 10, 8, 'symmetric'))
    const handle = handleOf(result, 'ex1')
    expect(handle.unit_scale).toBe(0.5)
    expectVecClose(handle.anchor, [5, 5, 4])
  })

  it('up_to extrude emits no distance handle', () => {
    const spec = {
      features: [
        rectSketchSk('sk1', 10, 10),
        { id: 'pl1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 7 } },
        { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, termination: 'up_to', up_to: '@pl1', operation: 'new' },
      ],
    }
    const result = h.run(spec)
    expect(h.res(result, 'ex1').status).toBe('ok')
    expect(h.res(result, 'ex1').handle).toBeUndefined()
    // The datum plane is a real terminator: the prism stops at z=7, not at the
    // blind distance of 5. Before the resolver accepted the `plane` tag the
    // pick fell through to blind distance with a "did not resolve" warning, and
    // this test only checked the absent handle, so it passed on the bug.
    expect(h.res(result, 'ex1').solver_warning).toBeUndefined()
    const mesh = h.body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 10], [0, 10], [0, 7])
  })
})
