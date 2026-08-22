// @vitest-environment node
//
// Gated real-OCC parity gate for booleans.ts: the boolean +
// history + clean + compose pipeline. Builds the same overlapping boxes as
// the frozen golden fixture (booleanDiff.json), runs the ported
// pipeline, and asserts geometry parity (volume + face/edge/solid counts) plus
// the BrepDiff classification (new/inherited partition + Python's exact counts).
//
// Skips (not fails) when opencascade.js is absent, like the other real-OCC
// tests. Install with: cd frontend && npm run occ:install.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { makeBox } from './primitives'
import {
  booleanWithDiff,
  booleanWithHistory,
  volumeOf,
  countSolids,
  countSubShapes,
  type BooleanOp,
} from './booleans'
import fixture from './__fixtures__/booleanDiff.json'
import type { OccHistory, OccListOfShape, OccModule, OccShape } from './occTypes'

const oc = await loadOcc()

type Expected = {
  diff: Record<string, number>
  volume: number
  result_faces: number
  result_edges: number
  result_solids: number
}
type Fixture = {
  target: [number, number, number]
  tool: [number, number, number]
  cut: Expected
  fuse: Expected
  common: Expected
}
const fx = fixture as unknown as Fixture

describe.skipIf(!oc)('booleans.ts pipeline (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  const ops: BooleanOp[] = ['cut', 'fuse', 'common']
  for (const op of ops) {
    it(`${op}: geometry + BrepDiff parity with Python`, () => {
      const exp = fx[op]
      const [tx, ty, tz] = fx.target
      const [ux, uy, uz] = fx.tool
      const scope = new DisposeScope()
      try {
        const target = makeBox(occ, scope, tx, ty, tz)
        const tool = makeBox(occ, scope, ux, uy, uz)
        const { shape, diff } = booleanWithDiff(occ, scope, target, tool, op)

        // Geometry parity (version-independent ground truth).
        expect(volumeOf(occ, scope, shape)).toBeCloseTo(exp.volume, 4)
        const E = occ.TopAbs_ShapeEnum
        const resultFaces = countSubShapes(occ, scope, shape, E.TopAbs_FACE)
        const resultEdges = countSubShapes(occ, scope, shape, E.TopAbs_EDGE)
        expect(resultFaces).toBe(exp.result_faces)
        expect(resultEdges).toBe(exp.result_edges)
        expect(countSolids(occ, scope, shape)).toBe(exp.result_solids)

        // Classification partition: every output face/edge is classified once.
        expect(diff.new_faces.length + diff.inherited_faces.length).toBe(resultFaces)
        expect(diff.new_edges.length + diff.inherited_edges.length).toBe(resultEdges)

        // Exact BrepDiff list-length parity with the Python pipeline.
        const got: Record<string, number> = {
          new_faces: diff.new_faces.length,
          inherited_faces: diff.inherited_faces.length,
          new_edges: diff.new_edges.length,
          inherited_edges: diff.inherited_edges.length,
          modified_input_faces: diff.modified_input_faces.length,
          deleted_input_faces: diff.deleted_input_faces.length,
          modified_input_edges: diff.modified_input_edges.length,
          deleted_input_edges: diff.deleted_input_edges.length,
        }
        expect(got).toEqual(exp.diff)
      } finally {
        scope.dispose()
      }
    })
  }

  it('frees every TopTools_ListOfShape history.Modified hands back, including recordTool\'s informational check', () => {
    // Regression test: recordTool (the tool-side classify pass inside
    // booleanWithHistory) used to call `history.Modified(s).Size() > 0` without
    // tracking the returned TopTools_ListOfShape, leaking one native list per
    // tool sub-shape checked -- the same shape of leak drainList had before it
    // tracked the list container itself. Spy on BRepTools_History.prototype (the
    // module exposes the class directly, and every algo.History() instance is
    // this one class) to capture every list Modified() hands back during the
    // run, then assert scope.dispose() deleted all of them, not just the ones
    // classifyTarget/collectPairs drain via drainList.
    const scope = new DisposeScope()
    try {
      const [tx, ty, tz] = fx.target
      const [ux, uy, uz] = fx.tool
      const target = makeBox(occ, scope, tx, ty, tz)
      const tool = makeBox(occ, scope, ux, uy, uz)

      const historyClass = (
        occ as unknown as {
          BRepTools_History: { prototype: { Modified: (s: OccShape) => OccListOfShape } }
        }
      ).BRepTools_History
      const captured: OccListOfShape[] = []
      const original = historyClass.prototype.Modified
      historyClass.prototype.Modified = function (this: OccHistory, s: OccShape): OccListOfShape {
        const list = original.call(this, s)
        captured.push(list)
        return list
      }
      try {
        booleanWithHistory(occ, scope, target, tool, 'cut')
      } finally {
        historyClass.prototype.Modified = original
      }

      expect(captured.length).toBeGreaterThan(0)
      scope.dispose()
      for (const list of captured) expect(list.isDeleted?.()).toBe(true)
    } finally {
      scope.dispose()
    }
  })
})
