// Always-on coverage for applyBodyOperation's OCC-free control-flow branches
// (no boolean is reached, so no real OCC module is needed). The geometry-bearing
// add/cut/new paths are gated against Python in bodyOpsReal.test.ts.

import { describe, it, expect } from 'vitest'
import { HandleTable } from '../occ/handleTable'
import { DisposeScope } from '../occ/disposeScope'
import { applyBodyOperation } from './bodyOps'
import type { OccModule, OccShape } from '../occ/occTypes'

// applyBodyOperation never touches `oc` or `toolShape` on these branches.
const oc = null as unknown as OccModule
const toolShape = null as unknown as OccShape

describe('applyBodyOperation OCC-free branches', () => {
  it('cut against an empty store with no target succeeds as a no-op', () => {
    const result = applyBodyOperation(oc, new DisposeScope(), new HandleTable(), {
      toolShape,
      bodyStore: {},
      operation: 'cut',
      mergeTarget: null,
      bodyId: 'body_f',
      featureId: 'featF',
      sketchId: 'skF',
      opName: 'extrude',
    })
    expect(result).toEqual({ status: 'ok', body_id: 'body_f', operation: 'cut' })
  })

  it('cut with an unknown merge target throws', () => {
    const store = {
      body_t: {
        id: 'body_t',
        created_by: 'featT',
        modified_by: [],
        shape: null,
        sketch_id: '',
        brep_diff: null,
        profile_queries: [],
      },
    }
    expect(() =>
      applyBodyOperation(oc, new DisposeScope(), new HandleTable(), {
        toolShape,
        bodyStore: store,
        operation: 'cut',
        mergeTarget: 'nope',
        bodyId: 'body_f',
        featureId: 'featF',
        sketchId: 'skF',
        opName: 'extrude',
      }),
    ).toThrow(/body not found for merge_target/)
  })
})
