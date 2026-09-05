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
import { makeBox, makeBoxAt } from './primitives'
import {
  booleanWithDiff,
  booleanWithHistory,
  volumeOf,
  countSolids,
  countSubShapes,
  shapesIntersect,
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

  it('walks each shape exactly once per (shape, kind) during booleanWithHistory (M19)', () => {
    // booleanWithHistory used to run TEN TopExp_Explorer walks where six do:
    // the result's faces three times (walkOutputs, collectPairs' unchanged
    // branch, the origin loop), the target's faces+edges and the tool's
    // faces+edges twice (classify/record + collectPairs). The exact count is
    // the contract: a later refactor that re-introduces a walk fails here with
    // a number, not a timeout.
    const scope = new DisposeScope()
    try {
      const [tx, ty, tz] = fx.target
      const [ux, uy, uz] = fx.tool
      const target = makeBox(occ, scope, tx, ty, tz)
      const tool = makeBox(occ, scope, ux, uy, uz)

      const occAny = occ as unknown as { TopExp_Explorer_2: unknown }
      const explorerCtor = occAny.TopExp_Explorer_2 as new (...args: unknown[]) => { delete: () => void }
      let count = 0
      occAny.TopExp_Explorer_2 = function (this: unknown, ...args: unknown[]) {
        count++
        return new explorerCtor(...args)
      }
      try {
        booleanWithHistory(occ, scope, target, tool, 'cut')
      } finally {
        occAny.TopExp_Explorer_2 = explorerCtor
      }
      expect(count).toBe(6)
    } finally {
      scope.dispose()
    }
  })

  it('classifies a boolean with sub-quadratic IsSame crossings in the result face count (M19)', () => {
    // The old per-input find and per-result filter paid one JS->WASM IsSame per
    // (input face, result face) / (result face, pair) crossing: O(F^2) per
    // boolean. The indexed rewrite should keep the count ~linear in the walked
    // sub-shapes. Patching TopoDS_Shape.prototype.IsSame intercepts calls made
    // on TopoDS_Face instances too (embind chains derived prototypes to the
    // base); the non-zero precondition below turns a missed patch into a loud
    // failure instead of a vacuous pass.
    const countIsSame = (target: OccShape, tool: OccShape): { crossings: number; faces: number } => {
      const s = new DisposeScope()
      try {
        let crossings = 0
        const shapeCtor = (occ as unknown as {
          TopoDS_Shape: { prototype: { IsSame: (o: unknown) => boolean } }
        }).TopoDS_Shape
        const proto = shapeCtor.prototype
        const original = proto.IsSame
        proto.IsSame = function (this: unknown, o: unknown): boolean {
          crossings++
          return original.call(this, o)
        }
        try {
          const { shape } = booleanWithHistory(occ, s, target, tool, 'cut')
          return {
            crossings,
            faces: countSubShapes(occ, s, shape, occ.TopAbs_ShapeEnum.TopAbs_FACE),
          }
        } finally {
          proto.IsSame = original
        }
      } finally {
        s.dispose()
      }
    }

    const scope = new DisposeScope()
    try {
      const [tx, ty, tz] = fx.target
      const [ux, uy, uz] = fx.tool
      // Small fixture: the standard overlapping boxes (9 result faces).
      const small = countIsSame(makeBox(occ, scope, tx, ty, tz), makeBox(occ, scope, ux, uy, uz))
      expect(small.crossings).toBeGreaterThan(0)  // the IsSame patch really intercepts

      // Larger fixture: the target cut by four non-overlapping through-columns,
      // so the result has several times more faces than the corner cut.
      const target = makeBox(occ, scope, 10, 10, 10)
      const slots = [
        makeBoxAt(occ, scope, [2, 2, -1], 2, 2, 12),
        makeBoxAt(occ, scope, [6, 2, -1], 2, 2, 12),
        makeBoxAt(occ, scope, [2, 6, -1], 2, 2, 12),
        makeBoxAt(occ, scope, [6, 6, -1], 2, 2, 12),
      ]
      let tool = slots[0]
      for (const slot of slots.slice(1)) {
        tool = scope.track(booleanWithDiff(occ, scope, tool, slot, 'fuse').shape)
      }
      const large = countIsSame(target, tool)
      expect(large.faces).toBeGreaterThan(small.faces)

      // Quadratic growth would scale crossings with faceRatio^2; linear scales
      // with faceRatio. Assert strictly below the square so a re-introduced
      // find/filter(IsSame) scan fails rather than passing on a low number.
      const faceRatio = large.faces / small.faces
      expect(large.crossings / small.crossings).toBeLessThan(faceRatio * faceRatio)
    } finally {
      scope.dispose()
    }
  })

  it('shapesIntersect answers the solid-count oracle for the box fixtures (L5)', () => {
    // L5's oracle trio. The verdict is a solid count, not a closed-volume one:
    // volumeOf's OnlyClosed=true integrates an open-shell intersection to ~0 and
    // would read a plain overlap as disjoint. The face-touching case pins the
    // NARROW fallback -- the common is face-only (0 solids) and both operands
    // ARE solids, so the fallback must not fire and the answer is false.
    const scope = new DisposeScope()
    try {
      const base = makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10)
      const overlap = makeBoxAt(occ, scope, [5, 0, 0], 10, 10, 10)
      const disjoint = makeBoxAt(occ, scope, [100, 0, 0], 10, 10, 10)
      const touching = makeBoxAt(occ, scope, [10, 0, 0], 10, 10, 10)
      expect(shapesIntersect(occ, base, overlap)).toBe(true)
      expect(shapesIntersect(occ, base, disjoint)).toBe(false)
      expect(shapesIntersect(occ, base, touching)).toBe(false)
    } finally {
      scope.dispose()
    }
  })
})
