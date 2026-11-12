// Unit test for the booleanWithHistory result-ownership on the error path.
//
// The result shape is deliberately untracked until the caller adopts it after
// the call returns, so a throw during classification used to strand the whole
// boolean solid (with all its sub-shapes) on the WASM heap. Driven with a fake
// OCC module whose history query throws; no opencascade.js needed.
//
// The second block pins the one-BRepCheck rule: the adoption guard validates
// the cleaned shape, and the soundness check must not validate the same handle
// again. Its fake module covers the whole pipeline (raw boolean, canonical
// passthrough, clean, volume reads, cavity fold, analyzer), all replaced by
// direct mocks so the analyzer call count is the only thing under test.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { booleanWithDiffMany, booleanWithHistory, BooleanSoundnessError } from '../booleans'
import { DisposeScope } from '../disposeScope'
import { volumeOf, volumeOfDefault } from '../volume'
import { canonicalizeCylinderFaces } from '../canonicalSurfaces'
import { foldCavitySolids } from '../cavities'
import type { OccModule, OccShape } from '../occTypes'

vi.mock('../volume', () => ({ volumeOf: vi.fn(), volumeOfDefault: vi.fn() }))
vi.mock('../canonicalSurfaces', () => ({ canonicalizeCylinderFaces: vi.fn() }))
vi.mock('../cavities', () => ({ foldCavitySolids: vi.fn() }))

class FakeShape {
  deleted = 0
  readonly volume: number
  constructor(volume: number) {
    this.volume = volume
  }
  delete(): void {
    this.deleted++
  }
}

function makeThrowingHistoryOcc(): { oc: OccModule; result: FakeShape } {
  const result = new FakeShape(0)
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

describe('booleanWithDiffMany runs one BRepCheck per adopted attempt', () => {
  type Harness = {
    oc: OccModule
    analyzerCalls: () => number
    cleans: FakeShape[]
    raws: FakeShape[]
  }

  /**
   * A fake module for the whole pipeline. Every raw boolean returns a fresh
   * shape whose volume comes from `rawVolumes` (the last entry repeats), and
   * every clean returns a fresh shape of `cleanVolume`. Nothing is explored,
   * so the history/diff composition runs empty and only the phases that call
   * the analyzer matter.
   */
  function harness(rawVolumes: number[], cleanVolume: number): Harness {
    let rawIndex = 0
    let analyzerCalls = 0
    const valid = true
    const raws: FakeShape[] = []
    const cleans: FakeShape[] = []
    const history = {
      IsRemoved: () => false,
      Modified: () => ({ Size: () => 0, First_1: () => undefined, RemoveFirst: () => {}, delete: () => {} }),
    }
    const algo = (shape: () => FakeShape) => ({
      SetArguments: () => {},
      SetTools: () => {},
      SetToFillHistory: () => {},
      Build: () => {},
      IsDone: () => true,
      Shape: () => shape() as unknown as OccShape,
      HasHistory: () => false,
      delete: () => {},
    })
    const oc = {
      TopAbs_ShapeEnum: { TopAbs_FACE: { value: 3 }, TopAbs_EDGE: { value: 1 }, TopAbs_SHAPE: { value: 8 } },
      TopTools_ListOfShape_1: function () {
        return { Append_1: () => {}, delete: () => {} }
      },
      BRepAlgoAPI_Cut_1: function () {
        return algo(() => {
          const shape = new FakeShape(rawVolumes[Math.min(rawIndex, rawVolumes.length - 1)])
          rawIndex++
          raws.push(shape)
          return shape
        })
      },
      BRepAlgoAPI_Fuse_1: function () {
        return algo(() => {
          const shape = new FakeShape(rawVolumes[Math.min(rawIndex, rawVolumes.length - 1)])
          rawIndex++
          raws.push(shape)
          return shape
        })
      },
      BRepAlgoAPI_Common_1: function () {
        return algo(() => new FakeShape(0))
      },
      ShapeUpgrade_UnifySameDomain_2: function () {
        return {
          AllowInternalEdges: () => {},
          Build: () => {},
          Shape: () => {
            const shape = new FakeShape(cleanVolume)
            cleans.push(shape)
            return shape as unknown as OccShape
          },
          History_1: () => ({ get: () => history, delete: () => {} }),
          delete: () => {},
        }
      },
      BRepCheck_Analyzer: function () {
        analyzerCalls++
        return { IsValid_2: () => valid, delete: () => {} }
      },
      TopExp_Explorer_2: function () {
        return { More: () => false, Next: () => {}, Current: () => undefined, delete: () => {} }
      },
    } as unknown as OccModule
    return {
      oc,
      analyzerCalls: () => analyzerCalls,
      cleans,
      raws,
    }
  }

  const shapesOf = (): { target: FakeShape; tool: FakeShape } => ({
    target: new FakeShape(10),
    tool: new FakeShape(1),
  })

  beforeEach(() => {
    vi.mocked(volumeOfDefault).mockImplementation(
      (_oc, _scope, shape) => (shape as unknown as FakeShape).volume,
    )
    vi.mocked(volumeOf).mockImplementation(
      (_oc, _scope, shape) => (shape as unknown as FakeShape).volume,
    )
    vi.mocked(canonicalizeCylinderFaces).mockImplementation((_oc, _scope, shape) => ({
      shape, changed: false, swaps: [], rebase: (s) => s,
    }))
    vi.mocked(foldCavitySolids).mockImplementation((_oc, _scope, shape) => shape)
  })

  it('a sound adopted fuse validates once, not twice', () => {
    const h = harness([10.5], 10.5)
    const { target, tool } = shapesOf()
    const scope = new DisposeScope()
    try {
      const result = booleanWithDiffMany(
        h.oc, scope, target as unknown as OccShape, [tool as unknown as OccShape], 'fuse',
      )
      expect(result.shape).toBe(h.cleans[0])
      expect(h.analyzerCalls()).toBe(1)
    } finally {
      scope.dispose()
    }
  })

  it('a folded cavity is validated again, because the fold replaces the checked shape', () => {
    const h = harness([10.5], 10.5)
    const folded = new FakeShape(10.5)
    vi.mocked(foldCavitySolids).mockImplementation(() => folded as unknown as OccShape)
    const { target, tool } = shapesOf()
    const scope = new DisposeScope()
    try {
      const result = booleanWithDiffMany(
        h.oc, scope, target as unknown as OccShape, [tool as unknown as OccShape], 'fuse',
      )
      expect(result.shape).toBe(folded)
      // One validation of the clean, one of the replacement: the skip is per
      // handle, never per attempt.
      expect(h.analyzerCalls()).toBe(2)
    } finally {
      scope.dispose()
    }
  })

  it('a rejected clean falls back to the raw rebuild and validates that result', () => {
    const h = harness([10, 10], 9)
    const { target, tool } = shapesOf()
    const scope = new DisposeScope()
    try {
      const result = booleanWithDiffMany(
        h.oc, scope, target as unknown as OccShape, [tool as unknown as OccShape], 'fuse',
      )
      expect(result.shape).toBe(h.raws[1])
      expect(result.shape).not.toBe(h.cleans[0])
      // The clean was never adopted, so its verdict validates nothing that
      // ships: its own validity read still ran (before the volume mismatch was
      // seen), and the raw fallback gets the one soundness check.
      expect(h.analyzerCalls()).toBe(2)
    } finally {
      scope.dispose()
    }
  })

  it('an unsound result still refuses with the same BooleanSoundnessError text', () => {
    const h = harness([20], 20)
    const { target, tool } = shapesOf()
    const scope = new DisposeScope()
    try {
      let error: unknown = null
      try {
        booleanWithDiffMany(h.oc, scope, target as unknown as OccShape, [tool as unknown as OccShape], 'fuse')
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(BooleanSoundnessError)
      expect((error as Error).message).toContain('volume 20 exceeds the operand sum 11')
    } finally {
      scope.dispose()
    }
  })
})
