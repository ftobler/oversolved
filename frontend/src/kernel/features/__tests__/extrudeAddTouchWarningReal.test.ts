// @vitest-environment node
//
// An `add` extrude that bridges two bodies fuses into the first one only. Before
// the warning, the second stayed separate with no hint: the caller saw two
// bodies and had to guess why. The decision is to warn (naming the untouched
// body and the one-step fix) rather than widen the fuse, which is a document
// change. A body the new solid only shares a FACE with is untouched in exactly
// the same way, and the volume probe cannot see it; the distance probe is the
// one that does. An add that reaches NO body is a different matter: it is a
// misplaced profile, so it fails the feature and names `operation: new` as the
// fix.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import {
  oc, solveBytes, extrudeTestHarness, extrudeSpec, fullRectExtrudeSpec,
} from '../extrudeRealSupport'

/** A rectangle sketch at an arbitrary (x, y) corner; Front unless `plane` says otherwise. */
function rectAt(
  sketchId: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plane = '@builtin_plane_front',
) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [x0, y0, x1, y0],
      right: [x1, y0, x1, y1],
      top: [x1, y1, x0, y1],
      left: [x0, y1, x0, y0],
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
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: y1 - y0 },
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
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'new' }),
        rectAt('skB', 5, 0, 7, 2),
        extrudeSpec('skB', 'exB', { distance: 3, operation: 'new' }),
        // A bridge spanning x 1..6: it overlaps both posts, so an unfused add
        // would reach both. Default add fuses only the first target.
        rectAt('skBridge', 1, 0.5, 6, 1.5),
        extrudeSpec('skBridge', 'exBridge', { distance: 4, operation: 'add' }),
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

  it('warns about a body the new solid only shares a face with', () => {
    const result = h.run({
      features: [
        // Post A at x 0..2, the body the bar reaches and fuses into first.
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'new' }),
        // Post B at x 5..7. The bar ends exactly on B's x=5 face, so the two
        // share a face and no volume: a Common sees nothing, a distance of 0
        // sees the contact.
        rectAt('skB', 5, 0, 7, 2),
        extrudeSpec('skB', 'exB', { distance: 3, operation: 'new' }),
        rectAt('skBar', 1, 0, 5, 2),
        extrudeSpec('skBar', 'exBar', { distance: 3, operation: 'add' }),
      ],
    })
    expect(h.res(result, 'exA').status).toBe('ok')
    expect(h.res(result, 'exB').status).toBe('ok')
    const bar = h.res(result, 'exBar')
    expect(bar.status).toBe('ok')
    expect(String(bar.solver_warning)).toContain('also touches body_exB; add a boolean union')
    expect(bar.body_id).toBe('body_exA')
    // The face contact is reported, not silently fused: B keeps its own id.
    expect(Object.keys(result.bodies).sort()).toEqual(['body_exA', 'body_exB'])
  })

  it('warns about a body the new solid fully encloses without touching', () => {
    const result = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'new' }),
        // A small body floating inside the bar's volume (z 1..2, at least a
        // millimetre clear of every bar face). The warning must name it even
        // though it shares no face with the bar: a body can be reached without
        // a contact surface.
        { id: 'plMid', kind: 'plane' as const, definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 1 } },
        rectAt('skInner', 5, 0, 6, 1, '@plMid'),
        extrudeSpec('skInner', 'exInner', { distance: 1, operation: 'new' }),
        // x 0.5..7, y -1..2, z 0..3: overlaps post A and swallows the inner body.
        rectAt('skBar', 0.5, -1, 7, 2),
        extrudeSpec('skBar', 'exBar', { distance: 3, operation: 'add' }),
      ],
    })
    expect(h.res(result, 'exInner').status).toBe('ok')
    const bar = h.res(result, 'exBar')
    expect(bar.status).toBe('ok')
    expect(String(bar.solver_warning)).toContain('also touches body_exInner')
    expect(bar.body_id).toBe('body_exA')
    expect(Object.keys(result.bodies).sort()).toEqual(['body_exA', 'body_exInner'])
  })

  it('does not warn when the add touches only its one target', () => {
    const result = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'new' }),
        rectAt('skB', 30, 0, 32, 2),
        extrudeSpec('skB', 'exB', { distance: 3, operation: 'new' }),
        // Standing on the first post, far from the second.
        rectAt('skCap', 0.5, 0.5, 1.5, 1.5),
        extrudeSpec('skCap', 'exCap', { distance: 4, operation: 'add' }),
      ],
    })
    expect(h.res(result, 'exCap').status).toBe('ok')
    expect(h.res(result, 'exCap').solver_warning).toBeUndefined()
  })

  it('fails an additive extrude that reaches no existing body', () => {
    const result = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'new' }),
        // Beside the first post, sharing no volume with it: add has nothing to
        // fuse with, so the feature fails instead of minting a second body.
        rectAt('skB', 5, 0, 7, 2),
        extrudeSpec('skB', 'exB', { distance: 3, operation: 'add' }),
      ],
    })
    expect(h.res(result, 'exA').status).toBe('ok')
    expect(h.res(result, 'exA').solver_warning).toBeUndefined()
    const disjoint = h.res(result, 'exB')
    expect(disjoint.status).toBe('exception')
    expect(String(disjoint.exception)).toContain('add does not merge with any existing body')
    expect(String(disjoint.exception)).toContain('move it onto the part')
    expect(Object.keys(result.bodies)).toEqual(['body_exA'])
  })

  it('fails an additive extrude on a document with no body at all', () => {
    const result = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'add' }),
      ],
    })
    const first = h.res(result, 'exA')
    expect(first.status).toBe('exception')
    expect(String(first.exception)).toContain('add has no existing body to extend')
    expect(String(first.exception)).toContain('use operation: new to create one')
    expect(result.bodies).toEqual({})
  })

  it('does not warn for operation new or cut beside an existing body', () => {
    const asNew = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'new' }),
        rectAt('skB', 5, 0, 7, 2),
        extrudeSpec('skB', 'exB', { distance: 3, operation: 'new' }),
      ],
    })
    expect(h.res(asNew, 'exB').solver_warning).toBeUndefined()
    expect(Object.keys(asNew.bodies).sort()).toEqual(['body_exA', 'body_exB'])

    const asCut = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'new' }),
        rectAt('skB', 1, 0.5, 3, 1.5),
        extrudeSpec('skB', 'exB', { distance: 3, operation: 'cut' }),
      ],
    })
    expect(h.res(asCut, 'exB').solver_warning).toBeUndefined()
    expect(h.res(asCut, 'exB').body_id).toBe('body_exA')
    expect(Object.keys(asCut.bodies)).toEqual(['body_exA'])
  })

  it('treats an empty merge_target as no target', () => {
    const specB = extrudeSpec('skB', 'exB', { distance: 3, operation: 'add' })
    const result = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'new' }),
        rectAt('skB', 5, 0, 7, 2),
        { ...specB, extrude: { ...specB.extrude, merge_target: '' } },
      ],
    })
    // An empty merge target is "automatic", so it takes the same disjoint road
    // as an absent one.
    expect(String(h.res(result, 'exB').exception)).toContain('add does not merge with any existing body')
  })

  it('does not warn when the additive extrude fuses into the existing body', () => {
    const result = h.run({
      features: [
        rectAt('skA', 0, 0, 2, 2),
        extrudeSpec('skA', 'exA', { distance: 3, operation: 'new' }),
        // Overlapping the first post, so the add fuses into it.
        rectAt('skB', 1, 0.5, 3, 1.5),
        extrudeSpec('skB', 'exB', { distance: 3, operation: 'add' }),
      ],
    })
    const fused = h.res(result, 'exB')
    expect(fused.status).toBe('ok')
    expect(fused.solver_warning).toBeUndefined()
    expect(fused.body_id).toBe('body_exA')
    expect(Object.keys(result.bodies)).toEqual(['body_exA'])
  })

  it('makes the first body with operation new, not add', () => {
    const result = h.run(fullRectExtrudeSpec(2, 2, 3))
    const first = h.res(result, 'ex1')
    expect(first.status).toBe('ok')
    expect(first.solver_warning).toBeUndefined()
  })
})
