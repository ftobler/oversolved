import { describe, it, expect } from 'vitest'
import {
  build,
  edgeAncestryPayload,
  findFirstDirty,
  hashCheckpointSpec,
  hashResultDict,
  validateIncremental,
  RESTORE_OWNER,
  type BuildDeps,
  type FeatureResult,
} from './builder'
import { resolve3dGeometry, projectTo2d } from './features/projectionLowering'
import { Repository, makeAncestryQuery, ref, canonical } from './query'
import { repoFromSnapshot } from './builder'
import type { BuildState, FeatureCheckpoint, Body } from './types3d'

function makeDeps(overrides?: Partial<BuildDeps>): BuildDeps {
  return {
    trySolveFeature: (_feature, _repo, _bodyStore, _featuresById): FeatureResult => ({ status: 'ok' }),
    postRegister: () => {},
    initGlobalRepo: () => new Repository(),
    tessellateBodies: () => ({}),
    ...overrides,
  }
}

function checkpoint(spec: Record<string, unknown>): FeatureCheckpoint {
  return {
    spec,
    result: {},
    repo_snapshot: { elements: {}, ancestral: {}, byUuid: {} },
    body_store_snapshot: {},
    bodies_snapshot: {},
  }
}

describe('findFirstDirty', () => {
  it('returns 0 when prevState is null', () => {
    expect(findFirstDirty([{ id: 'a' }], null)).toBe(0)
    expect(findFirstDirty([{ id: 'a' }], undefined)).toBe(0)
  })

  it('returns 0 when feature list length differs', () => {
    const prev: BuildState = {
      feature_order: ['a'],
      checkpoints: { a: checkpoint({ id: 'a', kind: 'sketch' }) },
    }
    expect(findFirstDirty([{ id: 'a' }, { id: 'b' }], prev)).toBe(0)
  })

  it('returns 0 when order differs', () => {
    const prev: BuildState = {
      feature_order: ['a', 'b'],
      checkpoints: {
        a: checkpoint({ id: 'a', kind: 'sketch' }),
        b: checkpoint({ id: 'b', kind: 'sketch' }),
      },
    }
    expect(findFirstDirty([{ id: 'b' }, { id: 'a' }], prev)).toBe(0)
  })

  it('returns 0 when spec changed', () => {
    const prev: BuildState = {
      feature_order: ['a'],
      checkpoints: { a: checkpoint({ id: 'a', kind: 'sketch', label: 'old' }) },
    }
    expect(findFirstDirty([{ id: 'a', kind: 'sketch', label: 'new' }], prev)).toBe(0)
  })

  it('returns len(features) when nothing changed', () => {
    const prev: BuildState = {
      feature_order: ['a', 'b'],
      checkpoints: {
        a: checkpoint({ id: 'a', kind: 'sketch' }),
        b: checkpoint({ id: 'b', kind: 'sketch' }),
      },
    }
    expect(findFirstDirty([{ id: 'a', kind: 'sketch' }, { id: 'b', kind: 'sketch' }], prev)).toBe(2)
  })

  it('dirties on any geometry-affecting param change', () => {
    const prev: BuildState = {
      feature_order: ['a'],
      checkpoints: { a: checkpoint({ id: 'a', kind: 'extrude', distance: 5 }) },
    }
    // Every non-volatile key participates: a distance edit must invalidate.
    // (Under the old placeholder whitelist this silently served stale geometry.)
    expect(findFirstDirty([{ id: 'a', kind: 'extrude', distance: 10 }], prev)).toBe(0)
  })

  it('ignores volatile transient keys (drag_anchor)', () => {
    const prev: BuildState = {
      feature_order: ['a'],
      checkpoints: { a: checkpoint({ id: 'a', kind: 'extrude', distance: 5 }) },
    }
    // drag_anchor is attached per drag-tick and must never dirty the cache.
    expect(findFirstDirty([{ id: 'a', kind: 'extrude', distance: 5, drag_anchor: 'e1' }], prev)).toBe(1)
  })
})

describe('hashCheckpointSpec', () => {
  it('is stable under key reorder', () => {
    const cp1 = checkpoint({ kind: 'extrude', id: 'x', distance: 3.0 })
    const cp2 = checkpoint({ distance: 3.0, kind: 'extrude', id: 'x' })
    expect(hashCheckpointSpec(cp1)).toBe(hashCheckpointSpec(cp2))
  })
})

describe('hashResultDict', () => {
  it('detects strict drift and tolerates 4dp', () => {
    const a = { ex1: { vertex: [1.0, 2.0, 3.0] } }
    const b = { ex1: { vertex: [1.0000001, 2.0, 3.0] } }
    expect(hashResultDict(a)).not.toBe(hashResultDict(b))
    expect(hashResultDict(a, 4)).toBe(hashResultDict(b, 4))
  })

  it('still catches structural diffs with fp_round', () => {
    const a = { ex1: { status: 'ok' } }
    const b = { ex1: { status: 'error' } }
    expect(hashResultDict(a, 4)).not.toBe(hashResultDict(b, 4))
  })

  it('strips solve_ms before hashing', () => {
    const a = { ex1: { status: 'ok', solve_ms: 1.2 } }
    const b = { ex1: { status: 'ok', solve_ms: 99.9 } }
    expect(hashResultDict(a)).toBe(hashResultDict(b))
  })
})

describe('build with mock solvers', () => {
  it('returns a build_state with feature_order', () => {
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }] },
      {},
      makeDeps(),
    )
    expect(r._build_state.feature_order).toEqual(['sk1', 'sk2'])
    expect('sk1' in r._build_state.checkpoints).toBe(true)
    expect('sk2' in r._build_state.checkpoints).toBe(true)
  })

  it('marks suppressed features without solving', () => {
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch', suppressed: true }] },
      {},
      makeDeps(),
    )
    expect(r.result.sk1).toEqual({ status: 'suppressed' })
  })

  it('detects an in-place nested edit after a suppressed build (spec not aliased)', () => {
    // The suppressed branch must deep-copy the spec like the solved branch:
    // findFirstDirty hashes checkpoint spec content, so a shallow copy aliases
    // the caller's doc and an in-place edit between builds mutates both sides
    // of the comparison, reporting the changed feature clean.
    const feature = { id: 'sk1', kind: 'sketch', params: { depth: 5 }, suppressed: true }
    const r = build({ features: [feature] }, {}, makeDeps())
    expect(findFirstDirty([feature], r._build_state)).toBe(1)
    ;(feature.params as Record<string, unknown>).depth = 9
    expect(r._build_state.checkpoints.sk1.spec).not.toBe(feature)
    expect((r._build_state.checkpoints.sk1.spec as Record<string, unknown>).params).toEqual({ depth: 5 })
    expect(findFirstDirty([feature], r._build_state)).toBe(0)
  })

  it('reuses clean prefix from prev_state', () => {
    const deps = makeDeps({
      trySolveFeature: (feature): FeatureResult => ({ status: 'ok', solved: feature.id }),
    })
    const r1 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }] },
      {},
      deps,
    )
    const r2 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch', label: 'new' }] },
      { prevState: r1._build_state },
      deps,
    )
    // sk1 should be identical from cache.
    expect(r2.result.sk1).toEqual(r1.result.sk1)
    // sk2 should have been re-solved.
    expect(r2.result.sk2).toMatchObject({ status: 'ok', solved: 'sk2' })
  })

  it('calls postRegister for each non-suppressed feature', () => {
    const calls: string[] = []
    const deps = makeDeps({
      postRegister: (_repo, fid) => { calls.push(fid) },
    })
    build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch', suppressed: true }] },
      {},
      deps,
    )
    expect(calls).toEqual(['sk1'])
  })

  it('catches solver exceptions and stores exception status', () => {
    const deps = makeDeps({
      trySolveFeature: (): FeatureResult => { throw new Error('boom') },
    })
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      {},
      deps,
    )
    expect(r.result.sk1).toMatchObject({ status: 'exception', exception: 'boom' })
  })

  it('supports rollback_position', () => {
    const deps = makeDeps()
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }] },
      { rollbackPosition: 1 },
      deps,
    )
    expect(r.result.sk2).toBeUndefined()
    // feature_order still contains both so dirty detection works later.
    expect(r._build_state.feature_order).toEqual(['sk1', 'sk2'])
  })

  it('supports pick_boundary returning pick_bodies', () => {
    const deps = makeDeps({
      tessellateBodies: (_store, _repo) => ({ body_sk1: { id: 'body_sk1' } }),
    })
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }] },
      { pickBoundary: 1 },
      deps,
    )
    expect(r.pick_bodies).toBeDefined()
  })

  it('pick_bodies carry real tessellated meshes for a mid-stack boundary (lazy)', () => {
// A body that exists at a mid-stack pick checkpoint must come back with real
// mesh/edge geometry (collision for picking). Under lazy checkpoint meshing the
// intermediate checkpoint carries an EMPTY bodies_snapshot, so the mesh is
// produced on demand by the pick path's tessellate fallback, not read from a
// pre-stored snapshot.
    let created = false
    const deps = makeDeps({
      trySolveFeature: (_f, _r, bodyStore): FeatureResult => {
        if (!created) {
          bodyStore['body_a'] = {
            id: 'body_a',
            created_by: 'f1',
            modified_by: [],
            shape: 7 as unknown as Body['shape'],
            sketch_id: '',
            brep_diff: null,
            profile_queries: [],
          }
          created = true
        }
        return { status: 'ok' }
      },
      tessellateBodies: (store) => Object.fromEntries(
        Object.keys(store).map((bid) => [bid, { mesh: { face_data: [] }, edges: [], vertices: [] }]),
      ),
    })
    const r = build(
      { features: [{ id: 'f1', kind: 'extrude' }, { id: 'f2', kind: 'fillet' }] },
      { pickBoundary: 1 },
      deps,
    )
    const pick = r.pick_bodies as Record<string, { mesh?: unknown }> | undefined
    expect(pick?.body_a?.mesh).toBeDefined()
    // f1 is not the final feature, so its checkpoint snapshot is lazy (empty):
    // the pick mesh above came from the on-demand tessellate fallback.
    const cp = r._build_state.checkpoints.f1
    expect(Object.keys(cp.bodies_snapshot as object).length).toBe(0)
  })

  it('calls deps.tessellateBodies with the body store', () => {
    let calledWith: unknown = null
    const deps = makeDeps({
      tessellateBodies: (store, _repo) => {
        calledWith = Object.keys(store)
        return { body_x: { mesh: { face_data: [] } } }
      },
      trySolveFeature: (_f, _r, bodyStore): FeatureResult => {
        bodyStore['body_x'] = {
          id: 'body_x',
          created_by: 'sk1',
          modified_by: [],
          shape: null,
          sketch_id: '',
          brep_diff: null,
          profile_queries: [],
        }
        return { status: 'ok' }
      },
    })
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      {},
      deps,
    )
    expect(calledWith).toEqual(['body_x'])
    expect(r.bodies['body_x']).toEqual({ mesh: { face_data: [] } })
  })

  it('registers B-rep edge ancestry into the live repo during the loop', () => {
    // Regression: the builder must register a body's B-rep face/edge/vertex
    // ancestry into the *live* repo as each feature solves (Python's
    // _register_body_faces), not only after the loop. Otherwise a later feature
    // resolving against an earlier body's edge -- e.g. a circular_array axis
    // edge-query -- sees an empty repo and falls back to a default axis, which in
    // the OCC path produced degenerate overlapping copies that hung the kernel
    // (translate.yaml real-doc anchor). The edge must be queryable WHEN f2 solves.
    const edge = { kind: 'line', start: [0, 0, 0], end: [0, 10, 0] }
    const edgePayload = { type: 'straightedge', kind: 'line', start: [0, 0, 0], end: [0, 10, 0], body_id: 'body_f1', created_by: 'f1', edge_index: 0 }
    let resolvedDuringF2: unknown = undefined
    const makeBody = (): Body => ({
      id: 'body_f1', created_by: 'f1', modified_by: [], shape: 1 as unknown as Body['shape'], sketch_id: '',
      brep_diff: null, profile_queries: [],
    })
    const deps = makeDeps({
      tessellateBodies: (store) => Object.fromEntries(
        Object.keys(store).map((bid) => [bid, { mesh: { face_data: [] }, edges: [edge], vertices: [] }]),
      ),
      trySolveFeature: (feature, repo, bodyStore): FeatureResult => {
        if (feature.id === 'f1') {
          bodyStore['body_f1'] = makeBody()
          repo.registerAncestor(['@body_f1/edge0', '@f1', '@body_f1'], edgePayload)
        } else if (feature.id === 'f2') {
          const q = makeAncestryQuery(['@body_f1/edge0', '@f1'], 'straightedge')
          resolvedDuringF2 = repo.query(q)
        }
        return { status: 'ok' }
      },
    })
    build({ features: [{ id: 'f1', kind: 'extrude' }, { id: 'f2', kind: 'circular_array' }] }, {}, deps)
    expect(resolvedDuringF2).not.toBeNull()
    expect((resolvedDuringF2 as Record<string, unknown>).start).toEqual([0, 0, 0])
    expect((resolvedDuringF2 as Record<string, unknown>).type).toBe('straightedge')
  })

  it('preserves _topo_ on full rebuild', () => {
    const deps = makeDeps()
    const r1 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      {},
      deps,
    )
    // Inject a fake topology entry into the checkpoint.
    const cp = r1._build_state.checkpoints.sk1
    ;(cp.repo_snapshot as Record<string, unknown>).elements = {
      _topo_sk1: { surfaces: [{ query: 'old' }] },
    }
    // Full rebuild with first_dirty=0.
    const r2 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      { prevState: r1._build_state },
      deps,
    )
    const rebuiltRepo = r2._build_state.checkpoints.sk1.repo_snapshot as Record<string, unknown>
    expect((rebuiltRepo.elements as Record<string, unknown>)._topo_sk1).toEqual({ surfaces: [{ query: 'old' }] })
  })

  it('re-tessellates pick_bodies when bodies_snapshot is empty', () => {
    const deps = makeDeps({
      tessellateBodies: (store, _repo) => {
        return Object.fromEntries(
          Object.keys(store).map((bid) => [bid, { id: bid, from_tessellate: true }])
        )
      },
    })
    const r1 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      {},
      deps,
    )
    // Force bodies_snapshot empty.
    const cp = r1._build_state.checkpoints.sk1
    cp.bodies_snapshot = {}
    const r2 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      { prevState: r1._build_state, pickBoundary: 1 },
      deps,
    )
    expect(r2.pick_bodies).toBeDefined()
    // Should have fallen back to tessellating body_store_snapshot.
  })
})

describe('validateIncremental', () => {
  it('passes L1-L3 on a healthy doc', () => {
    const deps = makeDeps()
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      {},
      deps,
    )
    const v = validateIncremental(r._build_state, r.result, { features: [{ id: 'sk1', kind: 'sketch' }] }, deps)
    expect(v.passed).toBe(true)
    expect(v.level).toBe(3)
    expect(v.diffs).toEqual({})
  })

  it('catches a corrupted checkpoint result at L2', () => {
    const deps = makeDeps()
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      {},
      deps,
    )
    const state = { ...r._build_state }
    state.checkpoints = { ...state.checkpoints }
    state.checkpoints.sk1 = { ...state.checkpoints.sk1, result: { status: 'TAMPERED' } }
    const incResult = { ...r.result, sk1: { status: 'TAMPERED' } }
    const v = validateIncremental(state, incResult, { features: [{ id: 'sk1', kind: 'sketch' }] }, deps)
    expect(v.passed).toBe(false)
    expect([2, 3]).toContain(v.level)
    expect(v.fp_only).toBeFalsy()
  })

  it('catches fp drift as L2 fp_only', () => {
    const deps = makeDeps({
      trySolveFeature: (): FeatureResult => ({ status: 'ok', value: 1.0 }),
    })
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      {},
      deps,
    )
    const incResult = { sk1: { status: 'ok', value: 1.0000001 } }
    const v = validateIncremental(r._build_state, incResult, { features: [{ id: 'sk1', kind: 'sketch' }] }, deps)
    expect(v.passed).toBe(false)
    expect(v.level).toBe(2)
    expect(v.fp_only).toBe(true)
  })

  it('catches corrupted body_store created_by at L3', () => {
    /**
     * Corrupting a body's created_by in the incremental state triggers a level-3 failure. This
     * is the control test: verifies the comparator catches body_store drift. Without this, a
     * bug in _diffRepoSnapshot could silently swallow corruption.
     */
    const deps = makeDeps({
      trySolveFeature: (_f, _r, bodyStore): FeatureResult => {
        bodyStore['body_ex1'] = {
          id: 'body_ex1',
          created_by: 'ex1',
          modified_by: [],
          shape: null,
          sketch_id: 'sk1',
          brep_diff: null,
          profile_queries: [],
        }
        return { status: 'ok' }
      },
    })
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'ex1', kind: 'extrude' }] },
      {},
      deps,
    )
    expect(r.result.ex1).toMatchObject({ status: 'ok' })

    const state = r._build_state
    const body = state.checkpoints.ex1.body_store_snapshot['body_ex1']
    expect(body).toBeDefined()
    body.created_by = 'TAMPERED'

    const v = validateIncremental(
      state,
      r.result,
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'ex1', kind: 'extrude' }] },
      deps,
    )
    expect(v.passed).toBe(false)
    expect(v.level).toBe(3)
  })
})


describe('checkpoint isolation', () => {
  it('result mutation does not corrupt cached checkpoint', () => {
    /**
     * Mutating the returned result dict must not affect the checkpoint used by the next partial
     * rebuild.
     */
    const deps = makeDeps({
      trySolveFeature: (feature): FeatureResult => ({ status: 'ok', solved: feature.id }),
    })
    const r1 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }] },
      {},
      deps,
    )
    const origSk1 = r1.result.sk1
    const state = r1._build_state

    // Mutate the returned result, must not propagate into the checkpoint.
    ;(r1.result as Record<string, unknown>).sk1 = { ...origSk1 as Record<string, unknown>, _mutated: 'taint' }

    const spec2 = { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }] }
    const r2 = build(spec2, { prevState: state }, deps)

    expect(r2.result.sk1).toEqual(origSk1)
    expect((r2.result as Record<string, unknown>).sk1).not.toHaveProperty('_mutated')
  })

  it('checkpoint result is a deep copy, not the same object as the returned result', () => {
    /**
     * The checkpoint stores an independent copy so the caller cannot corrupt the cache by
     * mutating the returned dict.
     */
    const deps = makeDeps()
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      {},
      deps,
    )
    const returned = r.result.sk1
    const checkpointResult = r._build_state.checkpoints.sk1.result
    expect(returned).not.toBe(checkpointResult)
    expect(returned).toEqual(checkpointResult)
  })
})

describe('feature insert / delete', () => {
  it('removes deleted feature from result and checkpoints', () => {
    /**
     * [sk1, sk2, sk3] -> [sk1, sk2]: sk3 absent from result and checkpoints, feature_order
     * updated.
     */
    const deps = makeDeps({
      trySolveFeature: (feature): FeatureResult => ({ status: 'ok', solved: feature.id }),
    })
    const r1 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }, { id: 'sk3', kind: 'sketch' }] },
      {},
      deps,
    )
    const state1 = r1._build_state
    expect('sk3' in state1.checkpoints).toBe(true)

    const r2 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }] },
      { prevState: state1 },
      deps,
    )
    const state2 = r2._build_state

    expect('sk3' in r2.result).toBe(false)
    expect('sk3' in state2.checkpoints).toBe(false)
    expect(state2.feature_order).toEqual(['sk1', 'sk2'])
    expect(r2.result.sk1).toEqual(r1.result.sk1)
    expect(r2.result.sk2).toEqual(r1.result.sk2)
  })

  it('inserts a feature mid-stack and re-solves downstream', () => {
    /**
     * [sk1, sk3] -> [sk1, sk2, sk3]: sk2 checkpoint created, sk3 re-solved. sk3 result
     * unchanged because its spec didn't change, but it goes through the solve loop because its
     * index shifted.
     */
    const deps = makeDeps({
      trySolveFeature: (feature): FeatureResult => ({ status: 'ok', solved: feature.id }),
    })
    const r1 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk3', kind: 'sketch' }] },
      {},
      deps,
    )
    const state1 = r1._build_state
    const geomSk3Before = r1.result.sk3

    const r2 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }, { id: 'sk3', kind: 'sketch' }] },
      { prevState: state1 },
      deps,
    )
    const state2 = r2._build_state

    expect('sk2' in state2.checkpoints).toBe(true)
    expect('sk3' in state2.checkpoints).toBe(true)
    expect(state2.feature_order).toEqual(['sk1', 'sk2', 'sk3'])
    expect(r2.result.sk2).toMatchObject({ status: 'ok' })
    expect(r2.result.sk3).toMatchObject({ status: 'ok' })
    // sk3 geometry is unchanged because its spec didn't change (deep copy from re-solve)
    const { solve_ms: _s1, ...geomSk3Expected } = geomSk3Before as Record<string, unknown>
    const { solve_ms: _s2, ...geomSk3Actual } = r2.result.sk3 as Record<string, unknown>
    expect(geomSk3Actual).toEqual(geomSk3Expected)
  })
})

// ─── rollback_position transition tests ───

const makeTrackerDeps = () => makeDeps({
  trySolveFeature: (feature): FeatureResult => ({ status: 'ok', solved: feature.id }),
})

describe('rollback transitions', () => {
  it('feature_order always contains the full feature list', () => {
    // BuildState.feature_order includes all features regardless of rollback_position.
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'sk2', kind: 'sketch' },
      { id: 'sk3', kind: 'sketch' },
    ]
    for (const rollback of [1, 2, 3]) {
      const r = build({ features }, { rollbackPosition: rollback }, makeDeps())
      expect(r._build_state.feature_order).toEqual(['sk1', 'sk2', 'sk3'])
    }
  })

  it('only solves features up to rollback_position', () => {
    // rollback_position=2 on a 4-feature stack only solves the first two.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
      { id: 'ex2', kind: 'extrude' },
    ]
    const r = build({ features }, { rollbackPosition: 2 }, deps)

    expect('sk1' in r.result).toBe(true)
    expect('ex1' in r.result).toBe(true)
    expect('sk2' in r.result).toBe(false)
    expect('ex2' in r.result).toBe(false)
    expect(r._build_state.feature_order).toEqual(['sk1', 'ex1', 'sk2', 'ex2'])
  })

  it('decreasing rollback reuses checkpoints for active features', () => {
    // Decreasing rollback from 3 to 2 reuses checkpoints for features before the cut.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const rFull = build({ features }, { rollbackPosition: 3 }, deps)
    const geomSk1Full = rFull.result.sk1

    const rRollback = build({ features }, { prevState: rFull._build_state, rollbackPosition: 2 }, deps)

    expect('sk1' in rRollback.result).toBe(true)
    expect('ex1' in rRollback.result).toBe(true)
    expect('sk2' in rRollback.result).toBe(false)
    expect(rRollback.result.sk1).toEqual(geomSk1Full)
    expect(rRollback.result.ex1).toEqual(rFull.result.ex1)
  })

  it('increasing rollback solves newly included features', () => {
    // Increasing rollback from 2 to 3 solves the newly included feature.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const rShort = build({ features }, { rollbackPosition: 2 }, deps)
    const rExtended = build({ features }, { prevState: rShort._build_state, rollbackPosition: 3 }, deps)

    expect('sk2' in rExtended.result).toBe(true)
    expect(rExtended.result.sk2).toMatchObject({ status: 'ok' })
    expect(rExtended.result.sk1).toEqual(rShort.result.sk1)
  })

  it('editing a feature beyond rollback does not dirty active features', () => {
    /**
     * Editing a feature past the rollback position does not invalidate checkpoints for features
     * before it.
     */
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const r1 = build({ features }, { rollbackPosition: 2 }, deps)
    const geomSk1 = r1.result.sk1

    // sk2 is beyond rollback; modifying it must not dirty sk1 or ex1.
    const features2 = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch', label: 'changed' },
    ]
    const r2 = build({ features: features2 }, { prevState: r1._build_state, rollbackPosition: 2 }, deps)

    expect(r2.result.sk1).toEqual(geomSk1)
    expect(r2.result.ex1).toMatchObject({ status: 'ok' })
    expect('sk2' in r2.result).toBe(false)
  })

  it('full build after partial rollback reuses all checkpoints', () => {
    // After a rollback=2 build, solving the full stack reuses checkpoints for sk1 and ex1.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const rPartial = build({ features }, { rollbackPosition: 2 }, deps)
    const geomSk1 = rPartial.result.sk1

    // Full build (no rollbackPosition) reuses checkpoints for active prefix.
    const rFull = build({ features }, { prevState: rPartial._build_state }, deps)

    expect(rFull.result.sk1).toEqual(geomSk1)
    expect(rFull.result.ex1).toEqual(rPartial.result.ex1)
    expect(rFull.result.sk2).toMatchObject({ status: 'ok' })
    expect(new Set(Object.keys(rFull.result as Record<string, unknown>))).toEqual(
      expect.objectContaining(new Set(['sk1', 'ex1', 'sk2']))
    )
  })

  it('same rollback position twice produces identical results', () => {
    // Solving at the same rollback position twice is stable.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const r1 = build({ features }, { rollbackPosition: 2 }, deps)
    const r2 = build({ features }, { prevState: r1._build_state, rollbackPosition: 2 }, deps)

    expect(r2.result.sk1).toEqual(r1.result.sk1)
    expect(r2.result.ex1).toEqual(r1.result.ex1)
  })

  it('undo/redo oscillation reuses checkpoints correctly each way', () => {
    // Simulate undo/redo: rollback 3->2->3 reuses checkpoints correctly each way.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const rFull = build({ features }, { rollbackPosition: 3 }, deps)
    const geomSk1 = rFull.result.sk1

    // Undo: rollback 3 -> 2
    const rUndo = build({ features }, { prevState: rFull._build_state, rollbackPosition: 2 }, deps)
    expect('sk2' in rUndo.result).toBe(false)
    expect(rUndo.result.sk1).toEqual(geomSk1)
    expect(rUndo.result.ex1).toMatchObject({ status: 'ok' })

    // Redo: rollback 2 -> 3
    const rRedo = build({ features }, { prevState: rUndo._build_state, rollbackPosition: 3 }, deps)
    expect(rRedo.result.sk2).toMatchObject({ status: 'ok' })
    expect(rRedo.result.sk1).toEqual(geomSk1)
  })
})

describe('pickBoundary edge cases', () => {
  it('pickBoundary=0 returns empty pick_bodies (empty doc before the first feature)', () => {
    const deps = makeDeps()
    const r = build(
      { features: [{ id: 'ex1', kind: 'extrude' }, { id: 'sk1', kind: 'sketch' }] },
      { pickBoundary: 0 },
      deps,
    )
    // The first non-builtin, non-sketch feature is ex1 (computePickBoundary
    // does not skip sketches, so it must lead the list). There is nothing
    // before it to pick against, but the key must still arrive (empty) so the
    // 'editing' world engages.
    expect(r.pick_bodies).toEqual({})
  })

  it('pickBoundary=null omits the pick_bodies key', () => {
    const deps = makeDeps()
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      { pickBoundary: null },
      deps,
    )
    expect(r.pick_bodies).toBeUndefined()
  })

  it('pickBoundary out of range should not return pick_bodies', () => {
    const deps = makeDeps()
    const r = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      { pickBoundary: 10 },
      deps,
    )
    expect(r.pick_bodies).toBeUndefined()
  })
})

describe('repo serialization', () => {
  it('repoFromSnapshot deduplicates elements with identical payloads', () => {
    // Two elements with identical payloads under the same ancestral key get collapsed.
    const payload = { type: 'flatface', body_id: 'b1' }
    const key = canonical(['@ex1face0', '@ex1'])
    const snapshot = {
      elements: { id1: { ...payload }, id2: { ...payload } },
      ancestral: { [key]: { set: ['@ex1face0', '@ex1'], eids: ['id1', 'id2'] } },
      byUuid: {},
    }
    const repo = repoFromSnapshot(snapshot)
    const entry = repo.ancestral.get(key)
    expect(entry?.eids).toHaveLength(1)
    expect(repo.elements.has('id2')).toBe(false)
  })

  // feature-repo-dedupe-payload-equality: the dedupe hash must reach into nested
  // objects. The old allowlist serializer (`Object.keys(payload).sort()`) is a
  // per-level property allowlist, so two payloads differing only in a nested
  // field both serialized to the same `{}` and one was silently deleted on
  // rehydrate. Both must survive now.
  it('keeps two elements that differ only in a nested-object field', () => {
    const key = canonical(['@ex1'])
    const snapshot = {
      elements: {
        id1: { type: 'solid', body_id: 'b1', meta: { ref: 'a' } },
        id2: { type: 'solid', body_id: 'b1', meta: { ref: 'b' } },
      },
      ancestral: { [key]: { set: ['@ex1'], eids: ['id1', 'id2'] } },
      byUuid: {},
    }
    const repo = repoFromSnapshot(snapshot)
    const entry = repo.ancestral.get(key)
    expect(entry?.eids).toEqual(['id1', 'id2'])
    expect(repo.elements.has('id1')).toBe(true)
    expect(repo.elements.has('id2')).toBe(true)
  })

  it('dedupes a byte-identical duplicate next to a nested-distinct sibling', () => {
    // Only a true duplicate is collapsed; a sibling that differs in nested
    // content is distinct and survives, so dedupe never over-merges.
    const key = canonical(['@ex1'])
    const snapshot = {
      elements: {
        id1: { type: 'solid', body_id: 'b1', meta: { ref: 'a' } },
        id2: { type: 'solid', body_id: 'b1', meta: { ref: 'a' } },
        id3: { type: 'solid', body_id: 'b1', meta: { ref: 'b' } },
      },
      ancestral: { [key]: { set: ['@ex1'], eids: ['id1', 'id2', 'id3'] } },
      byUuid: {},
    }
    const repo = repoFromSnapshot(snapshot)
    const entry = repo.ancestral.get(key)
    expect(entry?.eids).toHaveLength(2)
    expect(repo.elements.has('id2')).toBe(false)
    expect(repo.elements.has('id3')).toBe(true)
  })
})

describe('robustness', () => {
  it('features without id do not crash the build', () => {
    // Features missing the 'id' key must not crash with KeyError.
    const r = build({ features: [{}] }, {}, makeDeps())
    expect(r.result).toBeDefined()
  })
})

describe('clean prefix reuse', () => {
  it('_build_state is a separate key that can be removed', () => {
    /**
     * _build_state exists on the raw build() result and can be popped without affecting the
     * rest of the response.
     */
    const r = build({ features: [{ id: 'sk1', kind: 'sketch' }] }, {}, makeDeps())
    expect('_build_state' in r).toBe(true)
    const copy = { ...r }
    delete (copy as Record<string, unknown>)._build_state
    expect('_build_state' in copy).toBe(false)
  })

  it('unchanged feature list reuses all checkpoints', () => {
    // [sk1, sk2] -> [sk1, sk2] unchanged: all checkpoints are reused from cache.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'sk2', kind: 'sketch' },
    ]
    const r1 = build({ features }, {}, deps)
    const state1 = r1._build_state

    const r2 = build({ features }, { prevState: state1 }, deps)
    expect(r2.result.sk1).toEqual(r1.result.sk1)
    expect(r2.result.sk2).toEqual(r1.result.sk2)
  })
})

describe('edge cases', () => {
  it('rollback_position=0 followed by full build succeeds', () => {
    /**
     * Build with rollback_position=0 returns empty state; subsequent build with features does a
     * full rebuild.
     */
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
    ]

    const rEmpty = build({ features }, { rollbackPosition: 0 }, deps)
    expect(Object.keys(rEmpty._build_state.checkpoints)).toHaveLength(0)

    const rFull = build({ features }, { prevState: rEmpty._build_state }, deps)
    expect(rFull.result.sk1).toMatchObject({ status: 'ok' })
    expect(rFull.result.ex1).toMatchObject({ status: 'ok' })
  })

  it('corrupted checkpoint missing body_id does not crash rebuild', () => {
    // Missing body_id in body_store_snapshot should not crash.
    const deps = makeTrackerDeps()
    const features = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
    ]
    const r1 = build({ features }, {}, deps)
    const state1 = r1._build_state

    // Corrupt: remove body_ex1 from checkpoint snapshot.
    delete state1.checkpoints.ex1.body_store_snapshot['body_ex1']

    const features2 = [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
      { id: 'sk_new', kind: 'sketch' },
    ]
    const r2 = build({ features: features2 }, { prevState: state1 }, deps)
    expect(r2.result.sk_new).toMatchObject({ status: 'ok' })
  })

  it('GC removes ancestry entries for removed features', () => {
    /**
     * After rebuilding with fewer features, the final repo snapshot has no entries for removed
     * features.
     */
    const deps = makeDeps({
      trySolveFeature: (feature, repo): FeatureResult => {
        repo.registerAncestor([ref(feature.id as string)], { type: 'sketch', feature_id: feature.id })
        return { status: 'ok', solved: feature.id }
      },
    })
    const r1 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }] },
      {},
      deps,
    )

    // sk2 checkpoint should have @sk2 entries in its repo_snapshot.
    const sk2Snap = r1._build_state.checkpoints.sk2.repo_snapshot as Record<string, unknown>
    const sk2Ancestral = (sk2Snap.ancestral as Record<string, { set: string[] }>) ?? {}
    const hasSk2 = Object.keys(sk2Ancestral).some((k) => k.includes('@sk2'))
    expect(hasSk2).toBe(true)

    // Rebuild with only sk1.
    const r2 = build(
      { features: [{ id: 'sk1', kind: 'sketch' }] },
      { prevState: r1._build_state },
      deps,
    )

    // sk1 checkpoint in the new state must have no @sk2 ancestry entries.
    const sk1Snap = r2._build_state.checkpoints.sk1.repo_snapshot as Record<string, unknown>
    const sk1Ancestral = (sk1Snap.ancestral as Record<string, unknown>) ?? {}
    const hasSk2After = Object.keys(sk1Ancestral).some((k) => k.includes('@sk2'))
    expect(hasSk2After).toBe(false)
  })
})

describe('edgeAncestryPayload (projection round-trip)', () => {
  const XY = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0] }

  it('carries ellipse semi-axes so a resolved elliptical edge can be projected', () => {
    // Regression: the payload used to omit a/b, so resolve3dGeometry returned
    // null for a registered elliptical edge and the projection silently failed.
    const edge = {
      kind: 'ellipse', center: [0, 0, 0], a: 4, b: 2,
      axis: [0, 0, 1], x_axis: [1, 0, 0], angle_start: 0, angle_end: 2 * Math.PI,
    }
    const payload = edgeAncestryPayload(edge, '@body_1', '@cut1', 3)
    expect(payload.a).toBe(4)
    expect(payload.b).toBe(2)

    // The payload (as globalRepo would hand it back) must resolve to 3D ellipse
    // geometry and project to a 5-param ellipse on a coplanar sketch plane.
    const g = resolve3dGeometry({ type: 'edge', ...payload }, '?e')
    expect(g?.kindH).toBe('ellipse')
    const out = projectTo2d(g!, XY)
    expect(out?.kind).toBe('ellipse')
    expect(out?.params).toHaveLength(5)
  })

  it('still carries radius for circle/arc edges', () => {
    const payload = edgeAncestryPayload(
      { kind: 'circle', center: [1, 2, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0] },
      '@body_1', '@ex1', 0,
    )
    expect(payload.radius).toBe(5)
    expect(payload.type).toBe('edge')
  })
})

describe('clean-prefix restore copies are owned per build', () => {
  // Body shapes are opaque handles to the deps; plain numbers suffice here.
  const shapeOf = (n: number): NonNullable<Body['shape']> => n as unknown as NonNullable<Body['shape']>

  function bodySnapshot(fid: string, shapes: number[]): Record<string, Body> {
    const out: Record<string, Body> = {}
    shapes.forEach((s, i) => {
      out[`body_${fid}_${i}`] = {
        id: `body_${fid}_${i}`,
        created_by: fid,
        modified_by: [],
        shape: shapeOf(s),
        sketch_id: '',
        brep_diff: null,
        profile_queries: [],
      }
    })
    return out
  }

  function cpWithBodies(fid: string, spec: Record<string, unknown>, shapes: number[]): FeatureCheckpoint {
    return {
      spec,
      result: {},
      repo_snapshot: { elements: {}, ancestral: {}, byUuid: {} },
      body_store_snapshot: bodySnapshot(fid, shapes),
      bodies_snapshot: {},
    }
  }

  function makeRestoreTrackingDeps(events: string[]): BuildDeps {
    return makeDeps({
      copyBodyShape: (_shape, owner) => {
        events.push(`copy:${owner}`)
        return shapeOf(1000 + events.length)
      },
      retainCheckpointShape: (_h, owner) => {
        events.push(`retain:${owner}`)
        return shapeOf(0)
      },
      releaseCheckpoint: (fid) => events.push(`evict:${fid}`),
      releaseRestoreCopies: () => events.push('releaseRestore'),
    })
  }

  it('tags every copy with RESTORE_OWNER and releases the previous batch before minting new ones', () => {
    const specA = { id: 'a', kind: 'sketch' }
    const specB = { id: 'b', kind: 'extrude', distance: 5 }
    const prev: BuildState = {
      feature_order: ['a', 'b'],
      checkpoints: { a: cpWithBodies('a', specA, [1]), b: cpWithBodies('b', specB, []) },
    }

    // First incremental build: evict the discarded checkpoint, release the
    // (nonexistent) prior batch, then mint exactly one copy per clean body.
    const events1: string[] = []
    const r2 = build(
      { features: [specA, { ...specB, distance: 7 }] },
      { prevState: prev },
      makeRestoreTrackingDeps(events1),
    )
    expect(r2.result.b.status).toBe('ok')
    expect(events1.filter((e) => e.startsWith('copy:'))).toEqual([`copy:${RESTORE_OWNER}`])
    expect(events1.indexOf('releaseRestore')).toBeGreaterThanOrEqual(0)
    expect(events1.indexOf('releaseRestore')).toBeLessThan(events1.indexOf(`copy:${RESTORE_OWNER}`))

    // Second incremental build over the new state: the first build's batch is
    // released before the next one is minted. This ordering is the whole leak
    // fix -- an untagged or never-released batch would strand one deep copy
    // per body per edit in the real OCC table.
    const events2: string[] = []
    const r3 = build(
      { features: [specA, { ...specB, distance: 9 }] },
      { prevState: r2._build_state as BuildState },
      makeRestoreTrackingDeps(events2),
    )
    expect(r3.result.b.status).toBe('ok')
    expect(events2.indexOf('releaseRestore')).toBeLessThan(events2.indexOf(`copy:${RESTORE_OWNER}`))
    expect(events2.filter((e) => e === `copy:${RESTORE_OWNER}`)).toHaveLength(1)
  })

  it('evicts discarded checkpoints and their feature ids before restoring', () => {
    // The eviction loop must free BOTH owner tags of the outgoing generation:
    // the checkpoint retain ('cp:<fid>') and the base body registration
    // (<fid>). The wiring contract is pinned here at the call level.
    const specA = { id: 'a', kind: 'sketch' }
    const specB = { id: 'b', kind: 'extrude' }
    const prev: BuildState = {
      feature_order: ['a', 'b'],
      checkpoints: { a: cpWithBodies('a', specA, [1]), b: cpWithBodies('b', specB, [2]) },
    }
    const events: string[] = []
    build({ features: [specA, { ...specB, distance: 3 }] }, { prevState: prev }, makeRestoreTrackingDeps(events))
    expect(events).toContain('evict:b')
    expect(events).not.toContain('evict:a')  // clean prefix survives untouched
    expect(events.indexOf('evict:b')).toBeLessThan(events.indexOf(`copy:${RESTORE_OWNER}`))
  })
})
