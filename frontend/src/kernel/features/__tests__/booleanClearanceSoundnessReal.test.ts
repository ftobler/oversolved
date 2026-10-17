// @vitest-environment node
//
// The BooleanSoundnessError -> clearance translation in features/boolean.ts.
//
// It is only reachable when the grown tool clears the overlap probe yet the cut
// still comes back unsound. On this OCCT build the degenerate filleted -0.6 tool
// makes an empty Common, so the production probe reports "does not intersect"
// and the feature fails earlier with the direct clearance error
// (booleanClearanceReal.test.ts). This test overrides ONLY the overlap probe to
// report overlap, so the real cut runs and raises the real BooleanSoundnessError,
// proving the translation names the clearance instead of the tangency nudge.
//
// Skips when opencascade.js is absent, like the other real-OCC gates.

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBoxAt } from '../../occ/primitives'
import { applyFilletWithDiff } from '../../occ/edgeModifier'
import { Repository } from '../../query'
import { solveBoolean } from '../boolean'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { Vec3 } from '../../occ/primitives'

vi.mock('../../occ/booleans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/booleans')>()
  return { ...actual, shapesIntersect: vi.fn(() => true) }
})

const oc = await loadOcc()

describe.skipIf(!oc)('boolean clearance soundness translation (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('names the clearance when a grown tool produces an unsound cut', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const targetShape = makeBoxAt(occ, scope, [0, 0, 0] as Vec3, 10, 10, 8)
      const target: Body = {
        id: 'body_t', created_by: 'ex_t', modified_by: [],
        shape: table.register(targetShape, 'ex_t'), sketch_id: 'sk_t',
        brep_diff: null, profile_queries: [],
      }
      const box = makeBoxAt(occ, scope, [3, 3, -2] as Vec3, 4, 4, 12)
      const exp = scope.track(new occ.TopExp_Explorer_2(box, occ.TopAbs_ShapeEnum.TopAbs_EDGE, occ.TopAbs_ShapeEnum.TopAbs_SHAPE))
      const edges: OccShape[] = []
      for (; exp.More(); exp.Next()) edges.push(scope.track(occ.TopoDS.Edge_1(exp.Current())))
      const fillet = applyFilletWithDiff(occ, scope, box, 0.5, edges)
      expect(fillet.success).toBe(true)
      const tool: Body = {
        id: 'body_u', created_by: 'ex_u', modified_by: [],
        shape: table.register(scope.track(fillet.shape), 'ex_u'), sketch_id: 'sk_u',
        brep_diff: null, profile_queries: [],
      }

      let message = ''
      try {
        solveBoolean(
          occ, scope, table,
          { id: 'bool1', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u'], clearance: -0.6 } },
          new Repository(),
          { body_t: target, body_u: tool },
        )
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).toContain("clearance -0.6 could not be applied to tool 'body_u'")
      expect(message).toContain('Reduce the clearance')
    } finally {
      scope.dispose()
    }
  })
})
