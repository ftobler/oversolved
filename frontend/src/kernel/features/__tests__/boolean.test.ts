// Always-on tests for the boolean leaf's OCC-free guard paths (phase 2f). The
// geometry paths are gated in booleanSolveReal.test.ts.
//
// The ../occ/booleans module is mocked so a subtract can be driven without OCC
// and its booleanWithDiff call count inspected (M18). The guard-path tests
// below survive the mock: they throw before any OCC call.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DisposeScope } from '../../occ/disposeScope'
import { emptyBrepDiff } from '../../types3d'
import { Repository } from '../../query'
import { solveBoolean } from '../boolean'
import { HandleTable } from '../../occ/handleTable'
import type { OccModule } from '../../occ/occTypes'
import type { PartSolid } from '../../types3d'

const mocks = vi.hoisted(() => ({
  booleanWithDiff: vi.fn(),
  volumeOf: vi.fn(),
  shapesIntersect: vi.fn(),
  shapesTouch: vi.fn(),
}))

vi.mock('../../occ/booleans', () => ({
  booleanWithDiff: mocks.booleanWithDiff,
  volumeOf: mocks.volumeOf,
  shapesIntersect: mocks.shapesIntersect,
  shapesTouch: mocks.shapesTouch,
}))
// The near-coaxial warning walks the fused shape; these bodies have none.
vi.mock('../../occ/nearCoaxial', () => ({
  nearCoaxialCylinderWarning: () => null,
  shapeHasCoaxialCylinder: () => false,
}))
vi.mock('../booleanLineage', () => ({
  transferBooleanNames: () => ({
    faceNames: {}, edgeNames: {}, faceAncestry: {}, edgeAncestry: {},
  }),
}))
// Reading a body's names walks its OCC shape; these bodies have none.
vi.mock('../../occ/partNames', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/partNames')>()
  return { ...actual, readPartNames: () => actual.emptyShapeNames() }
})
vi.mock('../partSplit', () => ({
  resplitPart: () => ['body_t'],
}))

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable
const repo = new Repository()

function part(id: string): PartSolid {
  return {
    id,
    created_by: 'ex',
    modified_by: [],
    shape: null,
    sketch_id: 'sk',
    brep_diff: null,
    profile_queries: [],
  }
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  throw new Error('expected the solve to throw')
}

describe('solveBoolean guard paths', () => {
  beforeEach(() => {
    mocks.booleanWithDiff.mockReset()
    mocks.volumeOf.mockReset()
    mocks.shapesIntersect.mockReset()
    mocks.shapesTouch.mockReset()
  })

  // Every under-picked boolean names the pick the user still has to make, in
  // the words of its editor. The stored target/tools split stays internal, so
  // no thrown message may quote either key at the user.
  const solve = (operation: string, target: string, tools: string[]) => () =>
    solveBoolean(oc, scope, table, { id: 'b', boolean: { operation, target, tools } }, repo, {
      body_t: part('body_t'),
      body_u0: part('body_u0'),
    })

  const pickProblems: Array<[string, () => unknown, string]> = [
    ['union with no picks', solve('union', '', []), 'boolean: pick at least two parts to join'],
    ['union with the base only', solve('union', 'body_t', []), 'boolean: pick at least one more part to join'],
    ['subtract without a target', solve('subtract', '', ['body_u0']), 'boolean: pick the target part to subtract from'],
    ['subtract without a tool', solve('subtract', 'body_t', []), 'boolean: pick at least one tool part to subtract'],
    ['intersect without a target', solve('intersect', '', ['body_u0']), 'boolean: pick the target part to intersect'],
    ['intersect without a tool', solve('intersect', 'body_t', []), 'boolean: pick at least one tool part to intersect with'],
  ]

  for (const [name, run, message] of pickProblems) {
    it(`${name} names the missing pick`, () => {
      expect(thrownMessage(run)).toBe(message)
    })
  }

  it('never quotes a stored key in an under-picked boolean message', () => {
    for (const [, run] of pickProblems) {
      expect(thrownMessage(run)).not.toMatch(/'(tools|target)'/)
    }
  })

  it('rejects an unknown operation', () => {
    expect(() =>
      solveBoolean(
        oc,
        scope,
        table,
        { id: 'b', boolean: { operation: 'xor', target: 'body_t', tools: ['body_u0'] } },
        repo,
        { body_t: part('body_t'), body_u0: part('body_u0') },
      ),
    ).toThrow(/unknown operation 'xor'/)
  })

  it('rejects a present-but-non-numeric clearance by field name', () => {
    // The solve pipeline resolves expressions to numbers first, so a value that
    // reaches here as a string is malformed. It must fail loud rather than
    // silently become 0 (an ungrown cut, decision 6).
    expect(() =>
      solveBoolean(
        oc,
        scope,
        table,
        { id: 'b', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u0'], clearance: 'oops' } },
        repo,
        { body_t: part('body_t'), body_u0: part('body_u0') },
      ),
    ).toThrow(/'clearance' must be a number, got string/)
  })

  it('throws when tool body does not exist', () => {
    // The target must carry a real shape so the pre-loop "has no shape" guard
    // passes and the tool resolution is what fails.
    const table = new HandleTable()
    const target = part('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: 'body_t', tools: ['@body_missing'] },
      }, repo, {
        body_t: target,
      }),
    ).toThrow(/part not found/)
  })

  it('throws when target body does not exist', () => {
    // Target body that does not exist should raise.
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: '@body_missing', tools: ['body_u0'] },
      }, repo, {
        body_u0: part('body_u0'),
      }),
    ).toThrow(/part not found/)
  })

  it('target listed in tools throws the named error before any boolean runs', () => {
    // The refusal sits in the tool loop, so the target must reach it: a real
    // shape (any disposable) keeps the pre-loop "has no shape" guard from
    // firing first. The throw happens before any OCC work. A subtract keeps
    // the target/tools roles, so the pick guard is complete and the duplicate
    // reaches the loop.
    const table = new HandleTable()
    const target = part('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_t'] },
      }, repo, {
        body_t: target,
      }),
    ).toThrow(/cannot be its own tool/)
  })

  it('a union with another pick still refuses the target listed among its tools', () => {
    // The join list folds a duplicate of the base away, so a lone target-tool
    // pick is caught by the pick guard. With a second tool the list is
    // complete and the duplicate reaches the tool loop's own refusal.
    const table = new HandleTable()
    const target = part('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    const other = part('body_u0')
    other.shape = table.register({ delete: () => {}, isDeleted: () => false })
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: 'body_t', tools: ['body_u0', 'body_t'] },
      }, repo, {
        body_t: target,
        body_u0: other,
      }),
    ).toThrow(/cannot be its own tool/)
  })

  it('an alias tool ref that resolves to the target is refused the same way', () => {
    // The id comparison catches aliases too: '@ex1' and 'body_t' are the same
    // body, and resolving the tool must not be allowed to eat the target.
    const table = new HandleTable()
    const target = part('body_t')
    target.created_by = 'ex1'
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'subtract', target: 'body_t', tools: ['@ex1'] },
      }, repo, {
        body_t: target,
      }),
    ).toThrow(/cannot be its own tool/)
  })

  it('folds each tool through the real boolean; the probe is shapesIntersect, not a booleanWithDiff call (M18)', () => {
    // The subtract probe (boolean.ts) is shapesIntersect, a bare Common with
    // history off, so it never runs the booleanWithDiff pipeline. A folding
    // subtract pays for exactly ONE booleanWithDiff call per tool -- the real
    // 'cut'. Pre-Change 5 the probe ran the whole pipeline a second time
    // ('common').
    const scope = new DisposeScope()
    const table = new HandleTable()
    const target = part('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    const tool = part('body_u0')
    tool.shape = table.register({ delete: () => {}, isDeleted: () => false })
    const dummy = {
      shape: { delete: () => {}, isDeleted: () => false },
      diff: emptyBrepDiff(),
      faceOrigin: [],
    }
    mocks.booleanWithDiff.mockReturnValue(dummy)
    mocks.shapesIntersect.mockReturnValue(true)  // the probe reports overlap

    const result = solveBoolean(
      oc, scope, table,
      { id: 'b', boolean: { operation: 'subtract', target: 'body_t', tools: ['body_u0'] } },
      repo, { body_t: target, body_u0: tool },
    )
    expect(result.status).toBe('ok')
    const ops = mocks.booleanWithDiff.mock.calls.map((c) => c[4])
    expect(ops).toEqual(['cut'])
    expect(mocks.shapesIntersect).toHaveBeenCalledTimes(1)
  })

  it('flags an intersect that leaves an empty compound (no overlapping geometry)', () => {
    // shapesIntersect is a solid-count probe, so an intersect of touching or
    // zero-volume bodies can still fold to an empty result; the volume probe
    // names it instead of reporting a green no-op.
    const scope = new DisposeScope()
    const table = new HandleTable()
    const target = part('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    const tool = part('body_u0')
    tool.shape = table.register({ delete: () => {}, isDeleted: () => false })
    mocks.booleanWithDiff.mockReturnValue({
      shape: { delete: () => {}, isDeleted: () => false },
      diff: { ...emptyBrepDiff(), new_faces: [{} as never] },
      faceOrigin: [],
    })
    mocks.shapesIntersect.mockReturnValue(true)
    mocks.volumeOf.mockReturnValue(0)

    const result = solveBoolean(
      oc, scope, table,
      { id: 'b', boolean: { operation: 'intersect', target: 'body_t', tools: ['body_u0'] } },
      repo, { body_t: target, body_u0: tool },
    )
    expect(result.solver_warning).toMatch(/produced no overlapping geometry/)
  })

  it('leaves no empty-result warning when the volume probe itself fails', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const target = part('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    const tool = part('body_u0')
    tool.shape = table.register({ delete: () => {}, isDeleted: () => false })
    mocks.booleanWithDiff.mockReturnValue({
      shape: { delete: () => {}, isDeleted: () => false },
      diff: emptyBrepDiff(),
      faceOrigin: [],
    })
    mocks.shapesIntersect.mockReturnValue(true)
    mocks.volumeOf.mockImplementation(() => { throw new Error('probe blew up') })

    const result = solveBoolean(
      oc, scope, table,
      { id: 'b', boolean: { operation: 'intersect', target: 'body_t', tools: ['body_u0'] } },
      repo, { body_t: target, body_u0: tool },
    )
    expect(result.solver_warning).not.toMatch(/empty result/)
  })
})

describe('solveBoolean symmetric union/intersect (mock OCC)', () => {
  beforeEach(() => {
    mocks.booleanWithDiff.mockReset()
    mocks.volumeOf.mockReset()
    mocks.shapesIntersect.mockReset()
    mocks.shapesTouch.mockReset()
  })

  function rig3(): { scope: DisposeScope; table: HandleTable; store: Record<string, PartSolid>; shapes: Record<string, { delete: () => void; isDeleted: () => boolean }> } {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const shapes: Record<string, { delete: () => void; isDeleted: () => boolean }> = {
      a: { delete: () => {}, isDeleted: () => false },
      b: { delete: () => {}, isDeleted: () => false },
      c: { delete: () => {}, isDeleted: () => false },
      far: { delete: () => {}, isDeleted: () => false },
    }
    const store: Record<string, PartSolid> = {}
    for (const [key, id] of [['a', 'body_a'], ['b', 'body_b'], ['c', 'body_c'], ['far', 'body_far']] as const) {
      const b = part(id)
      b.created_by = key
      b.shape = table.register(shapes[key], id)
      store[id] = b
    }
    mocks.booleanWithDiff.mockImplementation(() => ({
      // A new face, so the empty-diff "no geometry change" warning stays out of
      // these assertions.
      shape: { delete: () => {}, isDeleted: () => false },
      diff: { ...emptyBrepDiff(), new_faces: [{} as never] },
      faceOrigin: [],
    }))
    return { scope, table, store, shapes }
  }

  it('folds in connectivity order from the base, not in pick order', () => {
    const { scope, table, store, shapes } = rig3()
    // A-B and B-C touch; A and C do not, so C can only arrive through B.
    mocks.shapesTouch.mockImplementation((_oc, x, y) =>
      (x === shapes.a && y === shapes.b) || (x === shapes.b && y === shapes.a)
      || (x === shapes.b && y === shapes.c) || (x === shapes.c && y === shapes.b))

    const result = solveBoolean(oc, scope, table, {
      id: 'b', boolean: { operation: 'union', target: 'body_a', tools: ['body_c', 'body_b'] },
    }, repo, store)

    expect(result.status).toBe('ok')
    expect(result.solver_warning).toBeUndefined()
    const calls = mocks.booleanWithDiff.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][2]).toBe(shapes.a)
    expect(calls[0][3]).toBe(shapes.b)
    expect(calls[1][3]).toBe(shapes.c)
    expect(Object.keys(store).sort()).toEqual(['body_a', 'body_far'])
  })

  it('skips a tool disconnected from the base and keeps its body', () => {
    const { scope, table, store, shapes } = rig3()
    mocks.shapesTouch.mockImplementation((_oc, x, y) =>
      (x === shapes.a && y === shapes.b) || (x === shapes.b && y === shapes.a))

    const result = solveBoolean(oc, scope, table, {
      id: 'b', boolean: { operation: 'union', target: 'body_a', tools: ['body_far', 'body_b'] },
    }, repo, store)

    expect(result.solver_warning).toContain('union: tool 1 does not intersect the target; skipped')
    expect(mocks.booleanWithDiff).toHaveBeenCalledTimes(1)
    expect(mocks.booleanWithDiff.mock.calls[0][3]).toBe(shapes.b)
    expect(Object.keys(store).sort()).toEqual(['body_a', 'body_c', 'body_far'])
  })

  it('expands a named body pattern in tools to its members, not the target', () => {
    const { scope, table, store, shapes } = rig3()
    store.body_b.created_by = 'pat1'
    store.body_c.created_by = 'pat1'
    // Both members touch the base, so both join and the order they fold in is
    // the store's own: B then C.
    mocks.shapesTouch.mockImplementation((_oc, x, y) =>
      (x === shapes.a && (y === shapes.b || y === shapes.c))
      || ((x === shapes.b || x === shapes.c) && y === shapes.a))

    const result = solveBoolean(oc, scope, table, {
      id: 'b', boolean: { operation: 'union', target: 'body_a', tools: ['@pat1'] },
    }, repo, store, {
      pat1: {
        id: 'pat1', kind: 'circular_pattern',
        circular_pattern: { subject: 'body', source_body: '@body_b' },
      },
    })

    expect(result.status).toBe('ok')
    const folded = mocks.booleanWithDiff.mock.calls.map((c) => c[3])
    expect(folded).toEqual([shapes.b, shapes.c])
    expect(Object.keys(store).sort()).toEqual(['body_a', 'body_far'])
  })
})
