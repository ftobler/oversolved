// @vitest-environment node
//
// bug-arc-profile D2 end to end: a box with one vertical edge filleted r2,
// and the fillet's quarter arc projected into a sketch on each cap face. On
// one cap the arc's source axis is parallel to the sketch normal, on the other
// anti-parallel (the projection mirrors the sweep). Either way the projected
// entity must be the 90 degree quarter the edge is, so the sector closed by two
// lines to its centre extrudes to pi * r^2 / 4. The mirrored arc used to land
// as its 270 degree complement, three times the area, with no message.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import type { BuildResponse } from '../../builder'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/booleans'
import type { OccShape } from '../../occ/occTypes'
import { oc, solveBytes, extrudeTestHarness, rectSketchSk, extrudeSpec } from '../extrudeRealSupport'

const R = 2
const SECTOR = (Math.PI * R * R) / 4

describe.skipIf(!oc || !solveBytes)('a projected fillet arc keeps its sweep (real OCC + Rust solver)', () => {
  const h = extrudeTestHarness()
  const sk1 = rectSketchSk('sk1', 10, 10)
  const ex1 = extrudeSpec('sk1', 'ex1', { distance: 5, operation: 'new' })

  function filleted(): Record<string, unknown>[] {
    const r0 = h.run({ features: [sk1, ex1] })
    const edges = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    // The vertical edge at the (10, 10) corner: on the +x and +y walls only.
    const corner = edges.filter((q) => q.endsWith(':straightedge') && q.includes('@cls_xp@cls_yp') && !q.includes('cls_z'))
    expect(corner).toHaveLength(1)
    return [sk1, ex1, { id: 'fi1', kind: 'fillet', label: 'Fillet', fillet: { edges: corner, radius: R } }]
  }

  function volume(result: BuildResponse, extrudeId: string): number {
    const store = result._build_state!.checkpoints[extrudeId].body_store_snapshot
    const scope = new DisposeScope()
    try {
      const id = `body_${extrudeId}`
      return volumeOf(oc!, scope, h.table.get<OccShape>(store[id].shape!))
    } finally {
      scope.dispose()
    }
  }

  // The two caps face opposite ways and both fillet arcs share the cylinder's
  // axis, so one cap sees it parallel to its normal and the other mirrored.
  it.each([['back cap', 'cls_zp'], ['front cap', 'cls_zn']])('projects the %s arc as its own quarter', (_, side) => {
    const base = filleted()
    const r1 = h.run({ features: base })
    const body = h.body(r1, 'body_ex1')
    const edges = (body.edge_queries as string[]) ?? []
    const faces = ((body.mesh as Record<string, unknown>).face_queries as string[]) ?? []
    const arc = edges.filter((q) => q.endsWith(':edge') && q.includes(`@cls_xp@cls_yp@${side}`))
    const cap = faces.filter((q) => q.endsWith(`@${side}:flatface`))
    expect(arc).toHaveLength(1)
    expect(cap).toHaveLength(1)

    // The sector: the projected arc closed by two lines through its centre.
    // The lines start anywhere; the coincidences pull them onto the pinned arc.
    const sk2 = {
      id: 'sk2', kind: 'sketch', plane: cap[0],
      entities: [
        { id: 'p0', kind: 'arc', source: arc[0] },
        { id: 'l1', kind: 'line' },
        { id: 'l2', kind: 'line' },
      ],
      initial: { l1: [0, 0, 1, 0], l2: [0, 1, 0, 0] },
      constraints: [
        { id: 'k1', kind: 'coincident', a: '$p0center', b: '$l1start' },
        { id: 'k2', kind: 'coincident', a: '$p0start', b: '$l1end' },
        { id: 'k3', kind: 'coincident', a: '$p0end', b: '$l2start' },
        { id: 'k4', kind: 'coincident', a: '$p0center', b: '$l2end' },
      ],
    }
    const ex2 = { id: 'ex2', kind: 'extrude', label: 'Sector', extrude: { sketch: '@sk2', distance: 1, direction: 'normal', operation: 'new' } }
    const r2 = h.run({ features: [...base, sk2, ex2] })

    const sk = h.res(r2, 'sk2')
    expect(sk.projection_errors ?? []).toEqual([])
    const [, , radius, a0, a1] = (sk.geometry as Record<string, number[]>).p0
    expect(radius).toBeCloseTo(R, 6)
    // Every arc consumer reads the stored angles counter-clockwise.
    const sweep = (((a1 - a0) % 360) + 360) % 360
    expect(sweep).toBeCloseTo(90, 6)

    expect(h.res(r2, 'ex2').status).toBe('ok')
    expect(volume(r2, 'ex2')).toBeCloseTo(SECTOR, 4)
  })
})
