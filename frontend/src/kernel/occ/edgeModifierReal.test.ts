// @vitest-environment node
//
// Gated real-OCC parity gate for edgeModifier.ts (the fillet/chamfer leaf's brep
// producer). Rebuilds the same 10-cube as the frozen golden fillet fixture,
// picks the same target edge by geom hash, applies the modifier, and asserts the
// output volume and BrepDiff sub-shape counts match Python.
//
// The geom-hash lineage transfer this gate used to assert was removed; the
// construction-name transfer that replaced it is covered end to end by
// constructionNameBooleanReal.test.ts. What remains here is the geometric +
// diff-classification parity, which is what the modifier still produces.
//
// Skips when opencascade.js is absent. The fixture is a frozen golden snapshot.
//
// The new_edges/inherited_edges counts were corrected away from the original
// Python snapshot (22/8 -> 8/22) when edgeModifier gained a geometry fallback
// for the fillet inherited-edge misclassification: BRepFilletAPI reports edges
// far from the filleted one as deleted/regenerated, so IsSame alone marked ~11
// unchanged cube edges as new. The old snapshot encoded that bug. Volume and
// lineage-token assertions are unchanged. See
// bugreports/revolve_bug_20260707_151218.md.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { makeBox } from './primitives'
import { volumeOf } from './booleans'
import { edgeToGeom } from './primitives'
import { edgeGeometryHash } from '../geomHash'
import { applyFilletWithLineage, applyChamferWithLineage } from './edgeModifier'
import type { OccModule, OccShape } from './occTypes'
import fixture from './__fixtures__/fillet.json'

const oc = await loadOcc()

type Counts = Record<string, number>
type Case = {
  name: string
  kind: string
  box: number[]
  value: number
  target_edge_hash: string
  volume: number
  diff_counts: Counts
}
const fx = fixture as unknown as { cases: Case[] }

function findEdgeByHash(oc2: OccModule, scope: DisposeScope, shape: OccShape, hash: string): OccShape {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const e = scope.track(oc2.TopoDS.Edge_1(exp.Current()))
    const { ed } = edgeToGeom(oc2, scope, e)
    if (edgeGeometryHash(ed as unknown as Record<string, unknown>) === hash) return e
  }
  throw new Error(`no edge with hash ${hash}`)
}

function firstEdge(oc2: OccModule, scope: DisposeScope, shape: OccShape): OccShape {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  if (!exp.More()) throw new Error('shape has no edges')
  return scope.track(oc2.TopoDS.Edge_1(exp.Current()))
}

function diffCounts(diff: Record<string, unknown[]>): Counts {
  return {
    new_faces: diff.new_faces.length,
    inherited_faces: diff.inherited_faces.length,
    new_edges: diff.new_edges.length,
    inherited_edges: diff.inherited_edges.length,
    modified_input_faces: diff.modified_input_faces.length,
    deleted_input_faces: diff.deleted_input_faces.length,
    modified_input_edges: diff.modified_input_edges.length,
    deleted_input_edges: diff.deleted_input_edges.length,
  }
}

describe.skipIf(!oc)('applyFillet/ChamferWithLineage (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  for (const c of fx.cases) {
    it(`${c.name}: volume + diff counts match Python`, () => {
      const scope = new DisposeScope()
      try {
        const box = makeBox(occ, scope, c.box[0], c.box[1], c.box[2])
        const edge = findEdgeByHash(occ, scope, box, c.target_edge_hash)
        // The geom-hash lineage transfer was removed; the construction-name
        // transfer through a fillet/chamfer is covered by
        // constructionNameBooleanReal.test.ts. Here we keep the volume + diff
        // classification parity, which is what the modifier still produces.
        const res =
          c.kind === 'fillet'
            ? applyFilletWithLineage(occ, scope, box, c.value, [edge])
            : applyChamferWithLineage(occ, scope, box, c.value, [edge], 'distance', 45.0)
        expect(res.success).toBe(true)
        expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(c.volume, 3)
        expect(diffCounts(res.diff as unknown as Record<string, unknown[]>)).toEqual(c.diff_counts)
      } finally {
        scope.dispose()
      }
    })
  }

  // The unit gate on the angle_distance arm. A chamfer at `angle` removes a
  // triangular prism whose legs are `distance` and `distance * tan(angle)`, so
  // the volume is the only thing that tells degrees from radians: at 45 degrees
  // tan is 1 and a 10-cube loses 5, at 45 RADIANS tan is ~1.6198 and it loses
  // ~8.1. The raw value used to reach AddDA, so this asserted number is the
  // difference between a 45 and a 41.4 degree bevel.
  it('angle_distance chamfer reads its angle as degrees, not radians', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(occ, scope, 10, 10, 10)
      const edge = firstEdge(occ, scope, box)
      const res = applyChamferWithLineage(occ, scope, box, 1, [edge], 'angle_distance', 45)
      expect(res.reason).toBe(null)
      expect(res.success).toBe(true)
      expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(1000 - 5, 3)
    } finally {
      scope.dispose()
    }
  })
})
