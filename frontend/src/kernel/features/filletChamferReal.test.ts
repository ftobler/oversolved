// @vitest-environment node
//
// Gated real-OCC end-to-end test for the fillet/chamfer LEAF wiring
// (filletChamfer.ts): edge-index build, query resolution, body routing, the OCC
// modifier call, and the in-place body-store + HandleTable update. The OCC
// producer's cross-language parity is gated separately in
// occ/edgeModifierReal.test.ts; here we verify the leaf threads a real body
// through solveFillet/solveChamfer.
//
// Edges are addressed via the index-form `?<bodyId>:edge:<n>` query, which the
// per-body edge index always emits, so the test does not depend on cross-build
// edge enumeration order.
//
// Skips when opencascade.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBox, faceCentroid, faceNormal } from '../occ/primitives'
import { volumeOf } from '../occ/booleans'
import { faceGeometryHash } from '../geomHash'
import { Repository } from '../query'
import { solveFillet, solveChamfer } from './filletChamfer'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'

const oc = await loadOcc()

function boxFaceLineage(occ: OccModule, scope: DisposeScope, box: OccShape): Record<string, string[]> {
  const E = occ.TopAbs_ShapeEnum
  const out: Record<string, string[]> = {}
  const exp = scope.track(new occ.TopExp_Explorer_2(box, E.TopAbs_FACE, E.TopAbs_SHAPE))
  let i = 0
  for (; exp.More(); exp.Next()) {
    const f = scope.track(occ.TopoDS.Face_1(exp.Current()))
    out[faceGeometryHash(faceCentroid(occ, scope, f), faceNormal(occ, scope, f))] = [`@face_${i++}`]
  }
  return out
}

describe.skipIf(!oc)('solveFillet/solveChamfer leaf (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  function makeBody(scope: DisposeScope, table: HandleTable): Record<string, Body> {
    const box = makeBox(occ, scope, 10, 10, 10)
    const faceLineage = boxFaceLineage(occ, scope, box)
    return {
      body_b: {
        id: 'body_b',
        created_by: 'ex1',
        modified_by: [],
        shape: table.register(scope.detach(box), 'ex1'),
        sketch_id: 'sk',
        brep_diff: null,
        profile_queries: [],
        face_lineage: faceLineage,
        edge_lineage: {},
      },
    }
  }

  it('fillet rounds a box edge, updates the body in place, threads lineage', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBody(scope, table)
      const result = solveFillet(
        occ,
        scope,
        table,
        { id: 'fil1', fillet: { edges: ['?body_b:edge:0'], radius: 2 } },
        new Repository(),
        bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(result.body_ids).toEqual(['body_b'])
      const body = bodyStore.body_b
      expect(body.modified_by).toEqual(['fil1'])
      expect(volumeOf(occ, scope, table.get<OccShape>(body.shape!))).toBeLessThan(1000)
      expect(volumeOf(occ, scope, table.get<OccShape>(body.shape!))).toBeGreaterThan(985)
      // Some original face tokens survive onto the trimmed output faces.
      expect(Object.keys(body.face_lineage).length).toBeGreaterThan(0)
      expect(body.brep_diff).not.toBeNull()
    } finally {
      scope.dispose()
    }
  })

  it('chamfer bevels a box edge', () => {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const bodyStore = makeBody(scope, table)
      const result = solveChamfer(
        occ,
        scope,
        table,
        { id: 'cha1', chamfer: { edges: ['?body_b:edge:0'], distance: 2 } },
        new Repository(),
        bodyStore,
      )
      expect(result.status).toBe('ok')
      expect(bodyStore.body_b.modified_by).toEqual(['cha1'])
      expect(volumeOf(occ, scope, table.get<OccShape>(bodyStore.body_b.shape!))).toBeCloseTo(980, 1)
    } finally {
      scope.dispose()
    }
  })
})
