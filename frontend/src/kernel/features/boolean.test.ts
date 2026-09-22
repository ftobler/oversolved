// Always-on tests for the boolean leaf's OCC-free guard paths (phase 2f). The
// geometry paths are gated in booleanSolveReal.test.ts.
//
// The ../occ/booleans module is mocked so a subtract can be driven without OCC
// and its booleanWithDiff call count inspected (M18). The guard-path tests
// below survive the mock: they throw before any OCC call.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DisposeScope } from '../occ/disposeScope'
import { emptyBrepDiff } from '../types3d'
import { Repository } from '../query'
import { solveBoolean } from './boolean'
import { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const mocks = vi.hoisted(() => ({
  booleanWithDiff: vi.fn(),
  volumeOf: vi.fn(),
  shapesIntersect: vi.fn(),
}))

vi.mock('../occ/booleans', () => ({
  booleanWithDiff: mocks.booleanWithDiff,
  volumeOf: mocks.volumeOf,
  shapesIntersect: mocks.shapesIntersect,
}))
vi.mock('./booleanLineage', () => ({
  transferBooleanNames: () => ({
    face_names: {}, edge_names: {}, face_ancestry: {}, edge_ancestry: {},
  }),
}))
vi.mock('./bodySplit', () => ({
  resplitBody: () => ['body_t'],
}))

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable
const repo = new Repository()

function body(id: string): Body {
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

describe('solveBoolean guard paths', () => {
  beforeEach(() => {
    mocks.booleanWithDiff.mockReset()
    mocks.volumeOf.mockReset()
    mocks.shapesIntersect.mockReset()
  })

  it('requires a target', () => {
    expect(() =>
      solveBoolean(oc, scope, table, { id: 'b', boolean: { tools: ['body_u0'] } }, repo, { body_u0: body('body_u0') }),
    ).toThrow(/'target' is required/)
  })

  it('requires at least one tool', () => {
    expect(() =>
      solveBoolean(oc, scope, table, { id: 'b', boolean: { target: 'body_t', tools: [] } }, repo, { body_t: body('body_t') }),
    ).toThrow(/must have at least one entry/)
  })

  it('rejects an unknown operation', () => {
    expect(() =>
      solveBoolean(
        oc,
        scope,
        table,
        { id: 'b', boolean: { operation: 'xor', target: 'body_t', tools: ['body_u0'] } },
        repo,
        { body_t: body('body_t'), body_u0: body('body_u0') },
      ),
    ).toThrow(/unknown operation 'xor'/)
  })

  it('throws when tool body does not exist', () => {
    // The target must carry a real shape so the pre-loop "has no shape" guard
    // passes and the tool resolution is what fails.
    const table = new HandleTable({ finalizerGuard: false })
    const target = body('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: 'body_t', tools: ['@body_missing'] },
      }, repo, {
        body_t: target,
      }),
    ).toThrow(/body not found/)
  })

  it('throws when target body does not exist', () => {
    // Target body that does not exist should raise.
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: '@body_missing', tools: ['body_u0'] },
      }, repo, {
        body_u0: body('body_u0'),
      }),
    ).toThrow(/body not found/)
  })

  it('target listed in tools throws the named error before any boolean runs', () => {
    // The refusal sits in the tool loop, so the target must reach it: a real
    // shape (any disposable) keeps the pre-loop "has no shape" guard from
    // firing first. The throw happens before any OCC work.
    const table = new HandleTable({ finalizerGuard: false })
    const target = body('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: 'body_t', tools: ['body_t'] },
      }, repo, {
        body_t: target,
      }),
    ).toThrow(/cannot be its own tool/)
  })

  it('an alias tool ref that resolves to the target is refused the same way', () => {
    // The id comparison catches aliases too: '@ex1' and 'body_t' are the same
    // body, and resolving the tool must not be allowed to eat the target.
    const table = new HandleTable({ finalizerGuard: false })
    const target = body('body_t')
    target.created_by = 'ex1'
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    expect(() =>
      solveBoolean(oc, scope, table, {
        id: 'b', boolean: { operation: 'union', target: 'body_t', tools: ['@ex1'] },
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
    const table = new HandleTable({ finalizerGuard: false })
    const target = body('body_t')
    target.shape = table.register({ delete: () => {}, isDeleted: () => false })
    const tool = body('body_u0')
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
})
