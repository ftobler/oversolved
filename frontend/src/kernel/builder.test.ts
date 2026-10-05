import { describe, it, expect } from 'vitest'
import {
  build,
  findFirstDirty,
  type FeatureResult,
} from './builder'
import { makeAncestryQuery, ref } from './query'
import type { Body } from './types3d'
import { makeDeps, makeTrackerDeps } from './builderTestUtils'

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
