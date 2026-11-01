// @vitest-environment node
//
// The G1 tangent chain a fillet/chamfer pick drags in (plan
// fillet-chamfer-tangent-chain). OCC continues a blend across a joint where the
// two edges meet tangentially, so one pick on a rounded loop edits the loop;
// the leaf counts the chain so it can say how far the blend went. These cases
// pin the criterion itself: a sharp corner is not a joint, a shallow kink is
// measured against TOL_MOVE_FACE_TANGENT in both directions, a stadium loop is
// one chain, and picks that already cover it add nothing.
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import {
  makeBox,
  makeLineEdge,
  makeArcEdge,
  makeWire,
  makeFaceFromWire,
  makePrism,
  edgeToGeom,
} from '../../occ/primitives'
import { canonicalEdges } from '../../occ/bodyNames'
import { tangentChain } from '../tangentChain'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

/** A 20 x 10 stadium plate, 5 thick: two straight sides joined by R5 end caps,
 *  so its top loop is four edges meeting tangentially. */
function stadium(occ: OccModule, scope: DisposeScope): OccShape {
  const edges = [
    makeLineEdge(occ, scope, [0, 0, 0], [20, 0, 0]),
    makeArcEdge(occ, scope, [20, 5, 0], [0, 0, 1], [1, 0, 0], 5, -Math.PI / 2, Math.PI / 2),
    makeLineEdge(occ, scope, [20, 10, 0], [0, 10, 0]),
    makeArcEdge(occ, scope, [0, 5, 0], [0, 0, 1], [1, 0, 0], 5, Math.PI / 2, (3 * Math.PI) / 2),
  ].map((edge) => scope.track(edge))
  const wire = scope.track(makeWire(occ, scope, edges, { requireClosed: true }))
  const face = scope.track(makeFaceFromWire(occ, scope, wire))
  return scope.track(makePrism(occ, scope, face, [0, 0, 1], 5))
}

/** A closed quadrilateral plate, 2 thick, whose corner at (20, 0) turns by
 *  `kink` radians from the first side; every other corner is sharp. */
function kinkedPlate(occ: OccModule, scope: DisposeScope, kink: number): OccShape {
  const c = 10 * Math.cos(kink)
  const s = 10 * Math.sin(kink)
  const corners: [number, number][] = [[0, 0], [20, 0], [20 + c, s], [-5, 20]]
  const edges = corners.map((from, i) => {
    const to = corners[(i + 1) % corners.length]
    return scope.track(makeLineEdge(occ, scope, [from[0], from[1], 0], [to[0], to[1], 0]))
  })
  const wire = scope.track(makeWire(occ, scope, edges, { requireClosed: true }))
  const face = scope.track(makeFaceFromWire(occ, scope, wire))
  return scope.track(makePrism(occ, scope, face, [0, 0, 1], 2))
}

/** The edges whose geometry is a straight line on the plate's top face, at z. */
function topLines(occ: OccModule, scope: DisposeScope, shape: OccShape, z: number): OccShape[] {
  const out: OccShape[] = []
  for (const edge of canonicalEdges(occ, scope, shape)) {
    const { ed } = edgeToGeom(occ, scope, edge)
    if (ed.kind === 'line' && Math.abs(ed.start[2] - z) < 1e-6) out.push(edge as OccShape)
  }
  return out
}

/** The top line that starts at the origin corner. */
function firstTopLine(occ: OccModule, scope: DisposeScope, shape: OccShape, z: number): OccShape {
  const line = topLines(occ, scope, shape, z).find((edge) => {
    const { ed } = edgeToGeom(occ, scope, edge)
    return ed.kind === 'line' && Math.abs(ed.start[0]) < 1e-9 && Math.abs(ed.start[1]) < 1e-9
  })
  if (line === undefined) throw new Error('no top line from the origin corner')
  return line
}

describe.skipIf(!oc)('tangentChain (real OCC)', () => {
  it('a box edge is a chain of one: its corners are not tangential', () => {
    const scope = new DisposeScope()
    try {
      const shape = scope.track(makeBox(oc!, scope, 10, 10, 10))
      const picked = canonicalEdges(oc!, scope, shape)[0] as OccShape
      expect(tangentChain(oc!, shape, [picked])).toEqual({ chain: 1, picked: 1 })
    } finally {
      scope.dispose()
    }
  })

  it('one top edge of a stadium plate reaches the whole four-edge loop', () => {
    const scope = new DisposeScope()
    try {
      const shape = stadium(oc!, scope)
      const lines = topLines(oc!, scope, shape, 5)
      expect(lines).toHaveLength(2)
      expect(tangentChain(oc!, shape, [lines[0]])).toEqual({ chain: 4, picked: 1 })
      // Two picks on the same loop stay one chain; the picks count separately.
      expect(tangentChain(oc!, shape, lines)).toEqual({ chain: 4, picked: 2 })
    } finally {
      scope.dispose()
    }
  })

  it('a shallow kink joins the chain, a visible one does not', () => {
    const scope = new DisposeScope()
    try {
      // 0.03 degrees is under TOL_MOVE_FACE_TANGENT (1e-3 rad); 1 degree is not.
      const shallow = kinkedPlate(oc!, scope, 5e-4)
      const kinked = kinkedPlate(oc!, scope, 1.7e-2)
      expect(tangentChain(oc!, shallow, [firstTopLine(oc!, scope, shallow, 2)])).toEqual({ chain: 2, picked: 1 })
      expect(tangentChain(oc!, kinked, [firstTopLine(oc!, scope, kinked, 2)])).toEqual({ chain: 1, picked: 1 })
    } finally {
      scope.dispose()
    }
  })

  it('picks that already cover the chain add nothing, and a repeated pick counts once', () => {
    const scope = new DisposeScope()
    try {
      const shape = stadium(oc!, scope)
      const loop = canonicalEdges(oc!, scope, shape)
        .filter((edge) => {
          const { ed } = edgeToGeom(oc!, scope, edge)
          if (ed.kind === 'line') return Math.abs(ed.start[2] - 5) < 1e-6
          if (ed.kind === 'arc' || ed.kind === 'circle') return Math.abs(ed.center[2] - 5) < 1e-6
          return false
        })
        .map((edge) => edge as OccShape)
      expect(loop).toHaveLength(4)
      expect(tangentChain(oc!, shape, loop)).toEqual({ chain: 4, picked: 4 })
      expect(tangentChain(oc!, shape, [loop[0], loop[0]])).toEqual({ chain: 4, picked: 1 })
    } finally {
      scope.dispose()
    }
  })
})
