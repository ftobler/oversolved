// @vitest-environment node
//
// Gated real-OCC parity gate for booleanLineage.ts (phase 2e shard 3). Builds
// the same overlapping boxes + geometry-derived lineage as
// the now-removed gen_boolean_lineage_fixture.py, runs the ported boolean +
// lineage transfer, and asserts the resulting face_lineage / edge_lineage match
// Python exactly (token lists sorted, since edge token order is adjacency-walk
// dependent and semantically a set).
//
// The output face-hash keys are recomputed by the port from its own OCC face
// reads, so a pass also confirms geom-hash parity end to end. Skips when
// opencascade.js is absent. The fixture is a frozen golden snapshot; its
// generator (gen_boolean_lineage_fixture.py) was deleted with the Python kernel
// in phase 4d.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { makeBox } from '../occ/primitives'
import { booleanWithDiff } from '../occ/booleans'
import { transferBooleanLineage } from './booleanLineage'
import fixture from '../occ/__fixtures__/booleanLineage.json'
import type { OccModule } from '../occ/occTypes'

const oc = await loadOcc()

type Lineage = Record<string, string[]>
type Fixture = {
  target: [number, number, number]
  tool: [number, number, number]
  target_face_lineage: Lineage
  tool_face_lineage: Lineage
  result_face_lineage: Lineage
  result_edge_lineage: Lineage
}
const fx = fixture as unknown as Fixture

function sortLineage(d: Lineage): Lineage {
  const out: Lineage = {}
  for (const [k, v] of Object.entries(d)) out[k] = [...v].sort()
  return out
}

describe.skipIf(!oc)('booleanLineage.ts transfer (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('cut: face + edge lineage parity with Python', () => {
    const [tx, ty, tz] = fx.target
    const [ux, uy, uz] = fx.tool
    const scope = new DisposeScope()
    try {
      const target = makeBox(occ, scope, tx, ty, tz)
      const tool = makeBox(occ, scope, ux, uy, uz)
      const { shape, diff } = booleanWithDiff(occ, scope, target, tool, 'cut')

      const { face_lineage, edge_lineage } = transferBooleanLineage(occ, scope, {
        bodyShape: shape,
        diff,
        oldTargetShape: target,
        toolShape: tool,
        faceLineage: fx.target_face_lineage,
        toolFaceLineage: fx.tool_face_lineage,
      })

      expect(sortLineage(face_lineage)).toEqual(sortLineage(fx.result_face_lineage))
      expect(sortLineage(edge_lineage)).toEqual(sortLineage(fx.result_edge_lineage))
    } finally {
      scope.dispose()
    }
  })
})
