// Always-on coverage for the cut path's intersection-probe failure handling.
// shapesIntersect (a bare Common with history off) returns TRUE when its own
// probe throws: a failed probe must not be treated as a zero-volume miss, which
// reported "does not intersect" for cuts the real cut would have performed.
// Mocks stand in for OCC so both probe outcomes are drivable.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  booleanWithDiff: vi.fn(),
  volumeOf: vi.fn(),
  shapesIntersect: vi.fn(),
}))

vi.mock('../occ/booleans', () => ({
  booleanWithDiff: mocks.booleanWithDiff,
  volumeOf: mocks.volumeOf,
  countSolids: () => 1,
  shapesIntersect: mocks.shapesIntersect,
}))
vi.mock('./booleanLineage', () => ({
  transferBooleanNames: () => ({
    face_names: {}, edge_names: {}, face_ancestry: {}, edge_ancestry: {},
  }),
}))
vi.mock('./bodySplit', () => ({
  registerSplitBodies: () => ['body_t'],
  resplitBody: () => ['body_t'],
}))

import { HandleTable } from '../occ/handleTable'
import { DisposeScope } from '../occ/disposeScope'
import { applyBodyOperation } from './bodyOps'
import { emptyBrepDiff } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = null as unknown as OccModule

function store(table: HandleTable): Record<string, Body> {
  const scope = new DisposeScope()
  return {
    body_t: {
      id: 'body_t',
      created_by: 'featT',
      modified_by: [],
      shape: table.register(scope.track({ delete: () => {} }), 'featT'),
      sketch_id: '',
      brep_diff: null,
      profile_queries: [],
    },
  }
}

function cut(table: HandleTable, storeOverride: Record<string, Body>) {
  return applyBodyOperation(oc, new DisposeScope(), table, {
    toolShape: { delete: () => {} } as unknown as OccShape,
    bodyStore: storeOverride,
    operation: 'cut',
    mergeTarget: 'body_t',
    bodyId: 'body_f',
    featureId: 'featF',
    sketchId: 'skF',
    opName: 'extrude',
  })
}

describe('cut intersection probe failures', () => {
  beforeEach(() => {
    mocks.booleanWithDiff.mockReset()
    mocks.volumeOf.mockReset()
    mocks.shapesIntersect.mockReset()
  })

  it('falls through to the real cut when the probe throws', () => {
    // shapesIntersect returns TRUE when its own probe throws (its docstring
    // contract: a failed probe is not evidence of disjointness), so the throw
    // must not read as a skip. The real cut runs.
    mocks.shapesIntersect.mockReturnValue(true)
    const table = new HandleTable({ finalizerGuard: false })
    const bodies = store(table)
    mocks.booleanWithDiff.mockImplementation(
      (_oc: unknown, _s: unknown, _a: unknown, _b: unknown, op: string) => {
        if (op !== 'cut') throw new Error(`unexpected op ${op}`)
        return { shape: { delete: () => {} }, diff: emptyBrepDiff(), faceOrigin: [] }
      },
    )
    const result = cut(table, bodies)
    expect(result.status).toBe('ok')
    expect(result.operation).toBe('cut')
    expect(bodies.body_t.modified_by).toEqual(['featF'])
  })

  it('surfaces the real cut failure, not "does not intersect"', () => {
    // Probe and cut fail alike; the error the user sees must be the cut's.
    mocks.shapesIntersect.mockReturnValue(true)
    mocks.booleanWithDiff.mockImplementation(
      (_oc: unknown, _s: unknown, _a: unknown, _b: unknown, op: string) => {
        throw new Error(`${op} boom`)
      },
    )
    const table = new HandleTable({ finalizerGuard: false })
    expect(() => cut(table, store(table))).toThrow(/cut boom/)
  })

  it('falls through to the real cut when the probe is unavailable (OCC null)', () => {
    // The probe is now shapesIntersect (a bare BRepAlgoAPI_Common, history
    // off), so it cannot be intercepted via the booleanWithDiff mock. When oc
    // is null the Common throws inside shapesIntersect, which answers true,
    // and the real cut proceeds -- exactly one booleanWithDiff call, nothing
    // from the probe.
    mocks.shapesIntersect.mockReturnValue(true)
    mocks.booleanWithDiff.mockImplementation(
      (_oc: unknown, _s: unknown, _a: unknown, _b: unknown, op: string) => {
        if (op !== 'cut') throw new Error(`unexpected op ${op}`)
        return { shape: { delete: () => {} }, diff: emptyBrepDiff(), faceOrigin: [] }
      },
    )
    const table = new HandleTable({ finalizerGuard: false })
    const result = cut(table, store(table))
    expect(result.status).toBe('ok')
    expect(result.operation).toBe('cut')
    const cutCalls = mocks.booleanWithDiff.mock.calls.filter((c) => c[4] === 'cut')
    expect(cutCalls).toHaveLength(1)
  })
})
