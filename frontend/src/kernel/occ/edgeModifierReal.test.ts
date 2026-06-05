// @vitest-environment node
//
// Gated real-OCC parity gate for edgeModifier.ts (phase 2f, the fillet/chamfer
// leaf's brep producer). Rebuilds the same 10-cube as
// tests/wasm_harness/gen_fillet_fixture.py, picks the same target edge by geom
// hash, feeds the same Python-keyed input lineage, applies the modifier, and
// asserts the output volume, BrepDiff sub-shape counts, and lineage.
//
// The input lineage maps are keyed by the box's face/edge geom hashes -- analytic
// (flat faces, line edges), so they agree cross-language and the TS producer
// transfers them by the same keys. Output lineage is compared by token-multiset:
// the curved fillet face's geom-hash key depends on its OCC-computed normal and
// diverges across the two builds (curved-face normal divergence accepted in 2b).
//
// Skips when opencascade.js is absent. Regenerate:
//   .venv/bin/python tests/wasm_harness/gen_fillet_fixture.py

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

type Lineage = Record<string, string[]>
type Counts = Record<string, number>
type Case = {
  name: string
  kind: string
  box: number[]
  value: number
  target_edge_hash: string
  face_lineage_in: Lineage
  edge_lineage_in: Lineage
  volume: number
  face_lineage_out: Lineage
  edge_lineage_out: Lineage
  diff_counts: Counts
}
const fx = fixture as unknown as { cases: Case[] }

function tokenMultiset(d: Lineage | null): string[] {
  return Object.values(d ?? {})
    .map((v) => JSON.stringify([...v].sort()))
    .sort()
}

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
    it(`${c.name}: volume + diff counts + lineage match Python`, () => {
      const scope = new DisposeScope()
      try {
        const box = makeBox(occ, scope, c.box[0], c.box[1], c.box[2])
        const edge = findEdgeByHash(occ, scope, box, c.target_edge_hash)
        const res =
          c.kind === 'fillet'
            ? applyFilletWithLineage(occ, scope, box, c.value, [edge], c.face_lineage_in, c.edge_lineage_in)
            : applyChamferWithLineage(occ, scope, box, c.value, [edge], 'distance', 45.0, c.face_lineage_in, c.edge_lineage_in)
        expect(res.success).toBe(true)
        expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(c.volume, 3)
        expect(diffCounts(res.diff as unknown as Record<string, unknown[]>)).toEqual(c.diff_counts)
        expect(tokenMultiset(res.faceLineage)).toEqual(tokenMultiset(c.face_lineage_out))
        expect(tokenMultiset(res.edgeLineage)).toEqual(tokenMultiset(c.edge_lineage_out))
      } finally {
        scope.dispose()
      }
    })
  }
})
