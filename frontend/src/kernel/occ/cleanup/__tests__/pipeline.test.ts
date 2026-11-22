/**
 * Pure tests of the cleanup layer's composition rules, over plain objects: no
 * WASM, no OCC. Each pass here is a fake that reports a rebase or a history,
 * which is exactly what the layer consumes; the real passes are covered by
 * cleanupReal.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { DisposeScope } from '../../disposeScope'
import { emptyShapeNames, type ShapeNames } from '../../partNames'
import { runCleanup, passStatus, unchanged } from '../pipeline'
import type { PassResult, SubShapeRebase } from '../types'
import type { OccHistory, OccModule, OccListOfShape, OccShape, OccSubShape } from '../../occTypes'

class FakeShape {
  deleted = 0
  delete(): void {
    this.deleted++
  }
  IsSame(other: unknown): boolean {
    return other === this
  }
}

const fake = (): FakeShape => new FakeShape()
const asShape = (s: FakeShape): OccShape => s as unknown as OccShape
const asSub = (s: FakeShape): OccSubShape => s as unknown as OccSubShape

/** A pass that maps one input handle to one output handle. */
function mappingPass(from: FakeShape, to: FakeShape) {
  return (): PassResult => ({
    shape: asShape(to),
    changed: true,
    rebase: (s) => (s === asSub(from) ? asSub(to) : s),
  })
}

function namesWith(faces: Array<[FakeShape, string]>): ShapeNames {
  const names = emptyShapeNames()
  for (const [face, uuid] of faces) names.faceNames.set(asSub(face), uuid)
  return names
}

/** The list drainList expects: a one-shot TopTools_ListOfShape lookalike. */
function listOf(shapes: FakeShape[]): OccListOfShape {
  const rest = [...shapes]
  return {
    Size: () => rest.length,
    First_1: () => asShape(rest[0]),
    RemoveFirst: () => {
      rest.shift()
    },
    delete: () => {},
  } as unknown as OccListOfShape
}

function historyOf(
  removed: FakeShape[],
  modified: Map<FakeShape, FakeShape[]>,
): OccHistory {
  return {
    IsRemoved: (s) => removed.includes(s as unknown as FakeShape),
    Modified: (s) => listOf(modified.get(s as unknown as FakeShape) ?? []),
    delete: () => {},
  } as unknown as OccHistory
}

const fakeOc = {} as OccModule

/** A fake module whose explorer yields `faces` and `edges` for the two kinds. */
function ocExploring(faces: FakeShape[], edges: FakeShape[] = []): OccModule {
  const kind = { TopAbs_FACE: { value: 3 }, TopAbs_EDGE: { value: 1 }, TopAbs_SHAPE: { value: 8 } }
  return {
    TopAbs_ShapeEnum: kind,
    TopExp_Explorer_2: function (shape: OccShape, type: { value: number }) {
      void shape
      const list = type.value === kind.TopAbs_FACE.value
        ? faces
        : type.value === kind.TopAbs_EDGE.value ? edges : []
      let at = 0
      return {
        More: () => at < list.length,
        Next: () => {
          at++
        },
        Current: () => asShape(list[at]),
        delete: () => {},
      }
    },
  } as unknown as OccModule
}

describe('runCleanup composition', () => {
  it('adopts a pass and re-keys a name from the input to the output', () => {
    const scope = new DisposeScope()
    try {
      const input = fake()
      const output = fake()
      const names = namesWith([[input, 'face-a']])
      const result = runCleanup(
        fakeOc,
        scope,
        { shape: asShape(input), names },
        [{ name: 'only', pass: mappingPass(input, output), selfGuarded: true }],
      )
      expect(result.changed).toBe(true)
      expect(result.shape).toBe(asShape(output))
      expect(result.passes).toEqual([{ name: 'only', status: 'adopted' }])
      expect(result.names?.faceNames.get(asSub(output))).toBe('face-a')
      expect(result.names?.faceNames.get(asSub(input))).toBeUndefined()
      expect(result.rebase(asSub(input))).toBe(asSub(output))
    } finally {
      scope.dispose()
    }
  })

  it('composes two adopted rebases in input order', () => {
    const scope = new DisposeScope()
    try {
      const s0 = fake()
      const s1 = fake()
      const s2 = fake()
      const names = namesWith([[s0, 'face-a']])
      const result = runCleanup(
        fakeOc,
        scope,
        { shape: asShape(s0), names },
        [
          { name: 'first', pass: mappingPass(s0, s1), selfGuarded: true },
          { name: 'second', pass: mappingPass(s1, s2), selfGuarded: true },
        ],
      )
      expect(result.shape).toBe(asShape(s2))
      expect(result.names?.faceNames.get(asSub(s2))).toBe('face-a')
      expect(result.rebase(asSub(s0))).toBe(asSub(s2))
      expect(result.passes.map((p) => p.status)).toEqual(['adopted', 'adopted'])
    } finally {
      scope.dispose()
    }
  })

  it('keeps the previous shape and leaves its rebase out when a pass is rejected', () => {
    const scope = new DisposeScope()
    try {
      const input = fake()
      const candidate = fake()
      const names = namesWith([[input, 'face-a']])
      const result = runCleanup(
        fakeOc,
        scope,
        { shape: asShape(input), names },
        [{
          name: 'refuses',
          pass: () => unchanged(asShape(candidate), true),
        }],
      )
      expect(result.changed).toBe(false)
      expect(result.shape).toBe(asShape(input))
      expect(result.names?.faceNames.get(asSub(input))).toBe('face-a')
      expect(passStatus(result, 'refuses')).toBe('rejected')
      // The pass's own candidate was never adopted, so its handle is not the
      // result and the identity rebase stays the identity.
      expect(result.rebase(asSub(input))).toBe(asSub(input))
    } finally {
      scope.dispose()
    }
  })

  it('reports a throwing pass as rejected and keeps the previous shape', () => {
    const scope = new DisposeScope()
    try {
      const input = fake()
      const result = runCleanup(
        fakeOc,
        scope,
        { shape: asShape(input) },
        [{
          name: 'throws',
          pass: () => {
            throw new Error('kernel said no')
          },
        }],
      )
      expect(result.changed).toBe(false)
      expect(result.shape).toBe(asShape(input))
      expect(result.passes).toEqual([{ name: 'throws', status: 'rejected' }])
    } finally {
      scope.dispose()
    }
  })

  it('rejects a pass whose guard cannot run, without adopting its candidate', () => {
    const scope = new DisposeScope()
    try {
      // The fake module lacks every volume read, so guardShape throws and the
      // layer must keep the previous shape rather than adopt what it cannot
      // judge (the same rule as a guard that returns false).
      const input = fake()
      const candidate = fake()
      const result = runCleanup(
        fakeOc,
        scope,
        { shape: asShape(input) },
        [{ name: 'guarded', pass: mappingPass(input, candidate) }],
      )
      expect(result.changed).toBe(false)
      expect(result.shape).toBe(asShape(input))
      expect(result.passes).toEqual([{ name: 'guarded', status: 'rejected' }])
    } finally {
      scope.dispose()
    }
  })

  it('composes names through a merging pass history, first source winning', () => {
    const scope = new DisposeScope()
    try {
      const left = fake()
      const right = fake()
      const merged = fake()
      const names = namesWith([[left, 'face-left'], [right, 'face-right']])
      const history = historyOf([], new Map([
        [left, [merged]],
        [right, [merged]],
      ]))
      const result = runCleanup(
        fakeOc,
        scope,
        { shape: asShape(left), names },
        [{
          name: 'merge',
          selfGuarded: true,
          pass: () => ({
            shape: asShape(merged),
            changed: true,
            rebase: (s) => s,
            history,
          }),
        }],
      )
      expect(result.changed).toBe(true)
      expect(result.names?.faceNames.get(asSub(merged))).toBe('face-left')
      expect(result.names?.faceNames.size).toBe(1)
    } finally {
      scope.dispose()
    }
  })

  it('drops a removed sub-shape\'s name and maps the diff through the merge', () => {
    const scope = new DisposeScope()
    try {
      const kept = fake()
      const gone = fake()
      const merged = fake()
      const names = namesWith([[kept, 'kept'], [gone, 'gone']])
      const history = historyOf([gone], new Map([[kept, [merged]]]))
      const diff = {
        new_faces: [], inherited_faces: [asSub(kept), asSub(gone)],
        new_edges: [], inherited_edges: [asSub(gone)],
        modified_input_faces: [], deleted_input_faces: [],
        modified_input_edges: [], deleted_input_edges: [],
      }
      const result = runCleanup(
        ocExploring([merged]),
        scope,
        { shape: asShape(kept), names, diff },
        [{
          name: 'merge',
          selfGuarded: true,
          pass: () => ({
            shape: asShape(merged),
            changed: true,
            rebase: (s) => s,
            history,
          }),
        }],
      )
      expect(result.names?.faceNames.get(asSub(merged))).toBe('kept')
      expect(result.names?.faceNames.size).toBe(1)
      expect(result.diff?.inherited_faces).toEqual([asSub(merged)])
      expect(result.diff?.inherited_edges).toEqual([])
    } finally {
      scope.dispose()
    }
  })

  it('does not adopt an unchanged pass and composes nothing through it', () => {
    const scope = new DisposeScope()
    try {
      const input = fake()
      const names = namesWith([[input, 'face-a']])
      const result = runCleanup(
        fakeOc,
        scope,
        { shape: asShape(input), names },
        [{
          name: 'noop',
          selfGuarded: true,
          pass: (): PassResult => ({
            shape: asShape(input),
            changed: false,
            rebase: (s) => s,
          }),
        }],
      )
      expect(result.changed).toBe(false)
      expect(result.shape).toBe(asShape(input))
      expect(result.passes).toEqual([{ name: 'noop', status: 'unchanged' }])
      expect(result.names?.faceNames.get(asSub(input))).toBe('face-a')
    } finally {
      scope.dispose()
    }
  })

  it('maps face origins through a one-to-one rebase', () => {
    const scope = new DisposeScope()
    try {
      const input = fake()
      const output = fake()
      const source = fake()
      const result = runCleanup(
        fakeOc,
        scope,
        {
          shape: asShape(input),
          faceOrigin: [{ output: asSub(input), source: asSub(source), fromTool: false }],
        },
        [{ name: 'only', pass: mappingPass(input, output), selfGuarded: true }],
      )
      expect(result.faceOrigin?.[0]?.output).toBe(asSub(output))
      expect(result.faceOrigin?.[0]?.source).toBe(asSub(source))
    } finally {
      scope.dispose()
    }
  })

  it('runs a later pass on the adopted shape of an earlier one', () => {
    const scope = new DisposeScope()
    try {
      const s0 = fake()
      const s1 = fake()
      const seen: OccShape[] = []
      const rebaseS0ToS1: SubShapeRebase = (s) => s
      runCleanup(
        fakeOc,
        scope,
        { shape: asShape(s0) },
        [
          { name: 'first', pass: mappingPass(s0, s1), selfGuarded: true },
          {
            name: 'second',
            selfGuarded: true,
            pass: (_oc, _scope, shape) => {
              seen.push(shape)
              return { shape, changed: false, rebase: rebaseS0ToS1 }
            },
          },
        ],
      )
      expect(seen).toEqual([asShape(s1)])
    } finally {
      scope.dispose()
    }
  })
})
