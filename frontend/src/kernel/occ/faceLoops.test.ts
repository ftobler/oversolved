// @vitest-environment node
//
// Unit tests for buildLoopFromWire's refusal of a gapped loop. No WASM build:
// a stub oc drives it, whose BRepAdaptor_Curve2d_2 throws for one edge. A
// failed pcurve read used to drop the edge and hand the caller a silently
// gapped loop; now it refuses by name.

import { describe, it, expect } from 'vitest'
import { buildLoopFromWire } from './faceLoops'
import { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'

// Stub oc: a wire explorer over `n` edges; the adaptor throws for `throwOnEdge`
// (index) and otherwise reads every edge as a plain line pcurve.
function stubOcc(throwOnEdge: number): OccModule {
  const n = 3
  const edges = Array.from({ length: n }, (_, i) => ({
    _id: i,
    // forward orientation: never equals TopAbs_REVERSED, so the pcurve keeps
    // its natural first->last parameter order
    Orientation_1: () => ({ value: 0 }),
    delete: () => {},
  }))
  let idx = 0
  const explorer = {
    More: () => idx < n,
    Next: () => {
      idx++
    },
    Current: () => edges[idx],
  }
  const adapter = function (edge: { _id: number }): unknown {
    if (edge._id === throwOnEdge) throw new Error('no pcurve for this edge')
    return {
      FirstParameter: () => 0,
      LastParameter: () => 1,
      GetType: () => ({ value: 0 }),  // GeomAbs_Line
      Value: (u: number) => ({ X: () => u, Y: () => u, delete: () => {} }),
      delete: () => {},
    }
  }
  return {
    TopAbs_Orientation: { TopAbs_REVERSED: { value: 2 } },
    GeomAbs_CurveType: { GeomAbs_Circle: { value: 1 }, GeomAbs_Line: { value: 0 } },
    BRepTools_WireExplorer_3: function () {
      return explorer
    },
    BRepAdaptor_Curve2d_2: adapter,
  } as unknown as OccModule
}

describe('buildLoopFromWire', () => {
  it('builds the loop when every boundary edge reads', () => {
    const oc = stubOcc(-1)
    const scope = new DisposeScope()
    const loop = buildLoopFromWire(oc, scope, {} as OccShape, {} as OccShape)
    expect(loop).toHaveLength(3)
    expect(loop.every((e) => e.kind === 'line')).toBe(true)
  })

  it('refuses a gapped loop when one edge cannot be read', () => {
    const oc = stubOcc(1)
    const scope = new DisposeScope()
    expect(() => buildLoopFromWire(oc, scope, {} as OccShape, {} as OccShape)).toThrow(
      /face loop: 1 of 3 boundary edge\(s\) could not be read; the loop would be gapped/,
    )
  })
})