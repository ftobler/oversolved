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
    // body_ids is explicitly empty, not absent: `body_id` names the body this
    // feature WOULD have minted, and a consumer reading `body_ids ?? [body_id]`
    // must not chase it.
    expect(result).toEqual({ status: 'ok', body_id: 'body_f', operation: 'cut', body_ids: [] })
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
    ).toThrow(/extrude: merge target 'nope' not found/)
  })

  it('cut skips a target body with no shape instead of dereferencing it', () => {
    // A target still in the store but not yet given a shape cannot be cut; the
    // loop must skip it and report the no-intersection failure rather than read
    // a null shape through the handle table.
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
        mergeTarget: 'body_t',
        bodyId: 'body_f',
        featureId: 'featF',
        sketchId: 'skF',
        opName: 'extrude',
      }),
    ).toThrow(/cut does not intersect any target body/)
  })

  it('add with a shape-less merge target fails loud instead of dropping the tool', () => {
    // The explicit merge target resolved but has no shape, so nothing can fuse.
    // The tool must not silently become its own body against an explicit target.
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
        operation: 'add',
        mergeTarget: 'body_t',
        bodyId: 'body_f',
        featureId: 'featF',
        sketchId: 'skF',
        opName: 'extrude',
      }),
    ).toThrow(/add could not fuse with any target body/)
  })
})
