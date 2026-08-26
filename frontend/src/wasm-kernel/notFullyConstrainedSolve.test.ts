// @vitest-environment node
//
// Regression for the "not fully constrained yet reported as such" bug
// (bugreports/not_fully_constrained_20260613_114547.md). A single line with its
// start coincident to the origin and a length dimension is still free to rotate
// about that pinned start. That rotation is a real, removable DOF (a horizontal
// or angle constraint would take it), so the sketch must report
// underconstrained. The old rigid-body-DOF allowance forgave this one DOF and
// wrongly reported fully constrained.
//
// Skips when the Rust solver build is absent.

import { describe, it, expect } from 'vitest'
import { loadSolver } from './loadSolver'
import { lowerSketch } from './lowerSketch'
import { encodeInput, decodeOutput, Status } from './codec'

const bytes = loadSolver()

describe.skipIf(!bytes)('not-fully-constrained detection', () => {
  it('line pinned at origin with only a length is underconstrained (rotation free)', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'L1', kind: 'line' }],
      initial: { L1: [0, 0, -9.858887672424316, -1.6740193367004395] },
      constraints: [
        // The dict form partDocToSketches resolves @builtin_origin into for a
        // builtin plane (lowerSketch takes resolved refs only).
        { kind: 'coincident', a: { entity: 'L1', point: 'start' }, b: { external_xy: [0, 0] } },
        { kind: 'length', target: { entity: 'L1' }, value: 10 },
      ],
    })
    const out = decodeOutput(bytes!(encodeInput(input)))

    expect(out.overallStatus).toBe(Status.underconstrained)
    // The length holds (feasible solve) and exactly one DOF remains: the line
    // entity (4 params) plus the injected origin point (2) gives 6 params, and
    // coincident (2) + length (1) + origin pin (2) leaves rank 5.
    expect(out.diagnostics.dof).toBe(1)
  })

  it('adding a horizontal constraint makes it fully constrained', () => {
    const { input } = lowerSketch({
      id: 'S1',
      entities: [{ id: 'L1', kind: 'line' }],
      initial: { L1: [0, 0, -9.858887672424316, -1.6740193367004395] },
      constraints: [
        { kind: 'coincident', a: { entity: 'L1', point: 'start' }, b: { external_xy: [0, 0] } },
        { kind: 'length', target: { entity: 'L1' }, value: 10 },
        { kind: 'horizontal', target: { entity: 'L1' } },
      ],
    })
    const out = decodeOutput(bytes!(encodeInput(input)))

    expect(out.overallStatus).toBe(Status.fully_constrained)
    expect(out.diagnostics.dof).toBe(0)
  })
})
