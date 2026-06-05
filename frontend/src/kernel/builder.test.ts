import { describe, it, expect } from 'vitest'
import {
  build,
  findFirstDirty,
  hashCheckpointSpec,
  hashResultDict,
  validateIncremental,
  type BuildDeps,
  type FeatureResult,
} from './builder'
import { Repository } from './query'
import type { BuildState, FeatureCheckpoint } from './types3d'

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
    repo_snapshot: { elements: {}, ancestral: {}, byGeomHash: {} },
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

  it('ignores keys outside FEATURE_CMP_KEYS', () => {
    const prev: BuildState = {
      feature_order: ['a'],
      checkpoints: { a: checkpoint({ id: 'a', kind: 'sketch', extrude: { distance: 5 } }) },
    }
    // extrude is not in COMMON_FEATURE_KEYS, so changes to it don't dirty.
    expect(findFirstDirty([{ id: 'a', kind: 'sketch', extrude: { distance: 10 } }], prev)).toBe(1)
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
    expect(r2.result.sk2).toEqual({ status: 'ok', solved: 'sk2' })
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
          face_lineage: {},
          edge_lineage: {},
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
})
