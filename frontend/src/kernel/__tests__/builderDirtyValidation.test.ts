import { describe, it, expect } from 'vitest'
import {
  build,
  findFirstDirty,
  hashCheckpointSpec,
  hashResultDict,
  validateIncremental,
  repoFromSnapshot,
  type FeatureResult,
} from '../builder'
import { canonical } from '../query'
import type { BuildState } from '../types3d'
import { makeDeps, checkpoint } from '../builderTestUtils'

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

  it('classifies a missing checkpoint as an L1 failure before comparing results', () => {
    const deps = makeDeps()
    const r = build({ features: [{ id: 'sk1', kind: 'sketch' }] }, {}, deps)
    // Drop the checkpoint: the spec-hash pass cannot even compare it, so the
    // failure is L1 rather than a downstream result diff.
    const state = { ...r._build_state, checkpoints: {} }
    const v = validateIncremental(state, r.result, { features: [{ id: 'sk1', kind: 'sketch' }] }, deps)
    expect(v.passed).toBe(false)
    expect(v.level).toBe(1)
    expect(v.diffs).toEqual({ missing_checkpoint: 'sk1' })
  })

  it('classifies a changed checkpoint spec as an L1 failure', () => {
    const deps = makeDeps()
    const r = build({ features: [{ id: 'sk1', kind: 'sketch' }] }, {}, deps)
    const state = { ...r._build_state }
    state.checkpoints = { ...state.checkpoints }
    state.checkpoints.sk1 = {
      ...state.checkpoints.sk1,
      spec: { ...state.checkpoints.sk1.spec, extra: 1 },
    }
    const v = validateIncremental(state, r.result, { features: [{ id: 'sk1', kind: 'sketch' }] }, deps)
    expect(v.passed).toBe(false)
    expect(v.level).toBe(1)
    expect(v.diffs).toEqual({ feature_id: 'sk1' })
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
     * bug in diffRepoSnapshot could silently swallow corruption.
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

  it('drops an ancestral entry whose every element is missing from the snapshot', () => {
    // A dangling entry (eids that do not appear in `elements`) must not survive
    // the restore, or the reverse index would claim keys nothing backs.
    const key = canonical(['@ex1'])
    const snapshot = {
      elements: {},
      ancestral: { [key]: { set: ['@ex1'], eids: ['ghost1', 'ghost2'] } },
      byUuid: {},
    }
    const repo = repoFromSnapshot(snapshot)
    expect(repo.ancestral.has(key)).toBe(false)
    expect(repo.byAncestorId.get('@ex1')).toBeUndefined()
  })
})
