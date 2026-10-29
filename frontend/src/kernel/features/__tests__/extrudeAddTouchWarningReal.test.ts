// @vitest-environment node
//
// An `add` extrude that bridges two bodies fuses into the first one only. Before
// the warning, the second stayed separate with no hint: the caller saw two
// bodies and had to guess why. The decision is to warn (naming the untouched
// body and the one-step fix) rather than widen the fuse, which is a document
// change.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import {
  oc, solveBytes, extrudeTestHarness, extrudeSpec, fullRectExtrudeSpec,
} from '../extrudeRealSupport'

/** A 2 x 2 rectangle sketch at an arbitrary (x, z) corner on the Front plane. */
function rectAt(sketchId: string, x0: number, z0: number, x1: number, z1: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [x0, z0, x1, z0],
      right: [x1, z0, x1, z1],
      top: [x1, z1, x0, z1],
      left: [x0, z1, x0, z0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: x1 - x0 },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: z1 - z0 },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('extrude add bridging two bodies (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()

  it('fuses the first body and warns that the new solid also touches the second', () => {
    const result = h.run({
      features: [
        // Two separate 2 x 2 posts, 3 mm tall, with a 3 mm gap between them.
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3 }),
        rectAt('skB', 5, 0, 7, 2),
        extrudeSpec('skB', 'exB', { distance: 3, operation: 'new' }),
        // A bridge spanning x 1..6: it overlaps both posts, so an unfused add
        // would reach both. Default add fuses only the first target.
        rectAt('skBridge', 1, 0.5, 6, 1.5),
        extrudeSpec('skBridge', 'exBridge', { distance: 4 }),
      ],
    })
    expect(h.res(result, 'exA').status).toBe('ok')
    expect(h.res(result, 'exB').status).toBe('ok')
    const bridge = h.res(result, 'exBridge')
    expect(bridge.status).toBe('ok')
    expect(String(bridge.solver_warning))
      .toContain('also touches body_exB; add a boolean union')

    // The second post is still a separate body: the warning describes the state,
    // it does not silently fuse.
    expect(Object.keys(result.bodies)).toContain('body_exB')
    expect(h.res(result, 'exBridge').body_id).toBe('body_exA')
  })

  it('does not warn when the add touches only its one target', () => {
    const result = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3 }),
        rectAt('skB', 30, 0, 32, 2),
        extrudeSpec('skB', 'exB', { distance: 3, operation: 'new' }),
        // Standing on the first post, far from the second.
        rectAt('skCap', 0.5, 0.5, 1.5, 1.5),
        extrudeSpec('skCap', 'exCap', { distance: 4 }),
      ],
    })
    expect(h.res(result, 'exCap').status).toBe('ok')
    expect(h.res(result, 'exCap').solver_warning).toBeUndefined()
  })

  it('warns when an additive extrude joins nothing and still mints one body', () => {
    const result = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3 }),
        // Beside the first post, sharing no volume with it: add has nothing to
        // fuse with, so the profile becomes a body of its own.
        rectAt('skB', 5, 0, 7, 2),
        extrudeSpec('skB', 'exB', { distance: 3 }),
      ],
    })
    expect(h.res(result, 'exA').status).toBe('ok')
    expect(h.res(result, 'exA').solver_warning).toBeUndefined()
    const disjoint = h.res(result, 'exB')
    expect(disjoint.status).toBe('ok')
    expect(String(disjoint.solver_warning)).toContain('add joined nothing')
    expect(String(disjoint.solver_warning)).toContain("'body_exB'")
    // Reporting only: the body count is the one the silent add already made.
    expect(Object.keys(result.bodies).sort()).toEqual(['body_exA', 'body_exB'])
    expect(disjoint.body_id).toBe('body_exB')
  })

  it('does not warn when the additive extrude fuses into the existing body', () => {
    const result = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3 }),
        // Overlapping the first post, so the add fuses into it.
        rectAt('skB', 1, 0.5, 3, 1.5),
        extrudeSpec('skB', 'exB', { distance: 3 }),
      ],
    })
    const fused = h.res(result, 'exB')
    expect(fused.status).toBe('ok')
    expect(fused.solver_warning).toBeUndefined()
    expect(fused.body_id).toBe('body_exA')
    expect(Object.keys(result.bodies)).toEqual(['body_exA'])
  })

  it('does not warn for the first body in the document', () => {
    const result = h.run(fullRectExtrudeSpec(2, 2, 3))
    const first = h.res(result, 'ex1')
    expect(first.status).toBe('ok')
    expect(first.solver_warning).toBeUndefined()
  })
})
