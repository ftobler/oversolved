// Unit test for the booleanWithHistory result-ownership on the error path.
//
// The result shape is deliberately untracked until the caller adopts it after
// the call returns, so a throw during classification used to strand the whole
// boolean solid (with all its sub-shapes) on the WASM heap. Driven with a fake
// OCC module whose history query throws; no opencascade.js needed.

import { describe, it, expect } from 'vitest'
import { booleanWithHistory } from './booleans'
import { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'

class FakeShape {
  deleted = 0
  delete(): void {
    this.deleted++
  }
}

function makeThrowingHistoryOcc(): { oc: OccModule; result: FakeShape } {
  const result = new FakeShape()
  const algo = {
    SetArguments: () => {},
    SetTools: () => {},
    SetToFillHistory: () => {},
    Build: () => {},
    IsDone: () => true,
    Shape: () => result as unknown as OccShape,
    HasHistory: () => true,
    History: () => ({
      get: () => {
        throw new Error('history unavailable')
      },
      delete: () => {},
    }),
    delete: () => {},
  }
  const oc = {
    TopAbs_ShapeEnum: { TopAbs_FACE: { value: 3 }, TopAbs_EDGE: { value: 1 }, TopAbs_SHAPE: { value: 8 } },
    BRepAlgoAPI_Cut_1: function () {
      return algo
    },
    TopTools_ListOfShape_1: function () {
      return { Append_1: () => {}, delete: () => {} }
    },
  } as unknown as OccModule
  return { oc, result }
}

describe('booleanWithHistory error path', () => {
  it('releases the result shape when classification throws', () => {
    const { oc, result } = makeThrowingHistoryOcc()
    const scope = new DisposeScope()
    expect(() =>
      booleanWithHistory(oc, scope, {} as OccShape, {} as OccShape, 'cut'),
    ).toThrow('history unavailable')
    // The outer scope owns the untracked result on the failure path; disposing
    // it must delete the boolean solid rather than leave it on the WASM heap.
    scope.dispose()
    expect(result.deleted).toBe(1)
  })
})
