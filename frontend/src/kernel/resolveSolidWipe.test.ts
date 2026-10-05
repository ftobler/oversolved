// `clearFeatureGeometryRegistrations` (`feature-resolve-solid-wipe`) wipes the
// `solid`/`extrusion-feature` entries a feature registered under `[@fid]` on every
// re-solve, and the body loop only re-registers solids for bodies it just created.
// This suite pins the `_reconcileFeatureSolids` evict-then-register invariant that
// keeps exactly one solid + one extrusion-feature per owned body, and it
// deliberately runs the REAL `postRegister` (the checkpoint-parity suite stubs it,
// which is why it could not see the wipe). The genuinely red-green fixed bug is
// in the checkpoint pass, which used to APPEND a duplicate solid for a body the
// loop could not register (live `[@fid]` held two identical solids and
// `?@fid:solid` threw AmbiguousQueryError); the loop-side reconcile is a
// contract pin guarding the evict property.
//
// The harness is OCC-free like the parity suite: `fakeMeta` stands in for both the
// render tessellation and the mesh-free metadata extractor, and a `make`/`modify`
// solve mutates the body store directly. What is NOT faked is `postRegister` and
// `build` itself, so the wipe and the body loop run for real.

import { describe, it, expect, beforeAll } from 'vitest'
import { build, type BuildDeps, type FeatureResult } from './builder'
import { Repository, makeAncestryQuery } from './query'
import { postRegister } from './features/postRegister'
import { repoFromSnapshot } from './builder'
import type { Body, FeatureCheckpoint, BuildState } from './types3d'
// Imported here, not mid-file, so the dependency surface is visible at the top
// like every other kernel test; only the skipIf-gated real-OCC section uses them.
import { loadOcc } from './occ/loadOcc'
import { SharedHarness } from './occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const SHAPE_SEED: Record<string, number> = { f1: 100, f2: 200 }

function shapeOf(n: number): Body['shape'] {
  return n as unknown as Body['shape']
}

function makeBody(fid: string, seed: number, extra?: Record<string, unknown>): Body {
  return {
    id: 'body_' + fid,
    created_by: fid,
    modified_by: [],
    shape: shapeOf(seed),
    sketch_id: 'sk_' + fid,
    brep_diff: null,
    profile_queries: ['@profile_' + fid],
    ...(extra ?? {}),
  }
}

const solve = (
  feature: Record<string, unknown>,
  _repo: Repository,
  bodyStore: Record<string, Body>,
): FeatureResult => {
  const fid = String(feature.id ?? '')
  if (feature.kind === 'make') {
    bodyStore['body_' + fid] = makeBody(fid, SHAPE_SEED[fid] ?? 1000)
  } else if (feature.kind === 'modify') {
    const body = bodyStore[String(feature.target)]
    if (body) {
      body.shape = shapeOf(Number(body.shape) + 1)
      body.modified_by = [...body.modified_by, fid]
    }
  }
  return { status: 'ok' }
}

function fakeMeta(_body: Body): Record<string, unknown> {
  return {
    mesh: {
      vertices: [], faces: [], triangle_to_face: [], face_queries: [],
      face_data: [], is_fallback: false,
    },
    edges: [], edge_queries: [], vertices: [], vertex_queries: [], vertex_uuids: [],
  }
}

interface HarnessOptions {
  /** Body ids the METADATA extractor drops (the loop cannot register their faces,
   *  so the checkpoint pass is the one that has to). */
  metaOmits?: string[]
}

class Harness {
  readonly options: HarnessOptions

  constructor(options: HarnessOptions = {}) {
    this.options = options
  }

  deps(): BuildDeps {
    const meta = (bodyStore: Record<string, Body>, isMetadataPath: boolean) =>
      Object.fromEntries(
        Object.entries(bodyStore)
          .filter(([bid]) => bodyStore[bid].shape != null
            && !(isMetadataPath && (this.options.metaOmits?.includes(bid) ?? false)))
          .map(([bid, b]) => [bid, fakeMeta(b)]),
      )
    return {
      trySolveFeature: solve,
      postRegister,
      initGlobalRepo: () => new Repository(),
      tessellateBodies: (store) => meta(store, false),
      extractBrepMetadata: (store) => meta(store, true),
      brepDiffNewFaceHashes: () => new Set(),
      brepDiffNewEdgeHashes: () => new Set(),
      brepDiffNewVertexHashes: () => new Set(),
    }
  }

  run(spec: Record<string, unknown>, prevState?: BuildState | null) {
    return build(spec, { prevState: prevState ?? null }, this.deps())
  }
}

// ─── checkpoint snapshot introspection ───

// The ancestral key a feature's solids/extrusion live under: exactly `[@fid]`.
function featureKey(ancestral: Record<string, { set: string[]; eids: string[] }>, fid: string): string {
  const key = Object.keys(ancestral).find((k) => {
    const set = ancestral[k].set
    return set.length === 1 && set[0] === '@' + fid
  })
  if (!key) throw new Error(`no [@${fid}] ancestral entry`)
  return key
}

function elementsOfType(checkpoint: FeatureCheckpoint, fid: string, type: string): unknown[] {
  const snap = checkpoint.repo_snapshot as Record<string, unknown>
  const elements = snap.elements as Record<string, Record<string, unknown>>
  const ancestral = snap.ancestral as Record<string, { set: string[]; eids: string[] }>
  const key = featureKey(ancestral, fid)
  return ancestral[key].eids.map((eid) => elements[eid]).filter((el) => el?.type === type)
}

function resolveSolid(checkpoint: FeatureCheckpoint, fid: string): Record<string, unknown> | null {
  const repo = repoFromSnapshot(checkpoint.repo_snapshot as Record<string, unknown>)
  const el = repo.query(makeAncestryQuery(['@' + fid], 'solid'))
  return el === null ? null : (el as Record<string, unknown>)
}

const TWO_MAKES = {
  features: [
    { id: 'f1', kind: 'make' },
    { id: 'f2', kind: 'make' },
  ],
}

// Build a feature owning two bodies whose meta extractor drops null-shape bodies
// exactly like the Harness `meta` above. With `secondShapeNull`, the second body
// carries `shape: null` (a body whose geometry never materialized); the first
// body always has a real shape, so the phantom-solid case can assert the null
// body adds no extra element under `[@f1]`.
function buildNullShapePair(secondShapeNull: boolean) {
  const spec = {
    features: [{ id: 'f1', kind: 'make', label: 'pair', body_ids: ['body_f1', 'body_f1_null'] }],
  }
  const solvePair = (
    feature: Record<string, unknown>,
    _repo: Repository,
    bodyStore: Record<string, Body>,
  ): FeatureResult => {
    const fid = String(feature.id ?? '')
    bodyStore['body_' + fid] = makeBody(fid, SHAPE_SEED[fid] ?? 1000, { id: 'body_' + fid })
    bodyStore['body_' + fid + '_null'] = makeBody(fid, (SHAPE_SEED[fid] ?? 1000) + 1, {
      id: 'body_' + fid + '_null',
      ...(secondShapeNull ? { shape: null } : {}),
    })
    return { status: 'ok' }
  }
  const meta = (store: Record<string, Body>) =>
    Object.fromEntries(
      Object.entries(store)
        .filter(([, b]) => b.shape != null)
        .map(([bid, b]) => [bid, fakeMeta(b)]),
    )
  const deps: BuildDeps = {
    trySolveFeature: solvePair,
    postRegister,
    initGlobalRepo: () => new Repository(),
    tessellateBodies: meta,
    extractBrepMetadata: meta,
    brepDiffNewFaceHashes: () => new Set<string>(),
    brepDiffNewEdgeHashes: () => new Set<string>(),
    brepDiffNewVertexHashes: () => new Set<string>(),
  }
  return build(spec, { prevState: null }, deps)
}

describe('real postRegister: solids survive a re-solve', () => {
  it('a cosmetic edit to a feature keeps ?@f1:solid resolving and in the checkpoint', () => {
    const h = new Harness()
    const cold = h.run(TWO_MAKES)
    // Baseline: the cold build registers the solid.
    expect(elementsOfType(cold._build_state!.checkpoints.f1, 'f1', 'solid')).toHaveLength(1)
    expect(elementsOfType(cold._build_state!.checkpoints.f1, 'f1', 'extrusion-feature')).toHaveLength(1)

    const edited = h.run(
      { features: [{ id: 'f1', kind: 'make', label: 'renamed' }, { id: 'f2', kind: 'make' }] },
      cold._build_state,
    )
    const cp = edited._build_state!.checkpoints.f1
    // The checkpoint carries exactly one solid for the one body f1 owns.
    expect(elementsOfType(cp, 'f1', 'solid')).toHaveLength(1)
    expect(elementsOfType(cp, 'f1', 'extrusion-feature')).toHaveLength(1)
    const solid = resolveSolid(cp, 'f1')
    expect(solid).not.toBeNull()
    expect(solid!.body_id).toBe('body_f1')
    expect(solid!.created_by).toBe('f1')
  })

  it('the reconcile is idempotent across repeated cosmetic re-solves', () => {
    const h = new Harness()
    let state: BuildState | null = null
    let label = 0
    for (let i = 0; i < 3; i++) {
      const r = h.run(
        { features: [{ id: 'f1', kind: 'make', label: `v${label++}` }] },
        state,
      )
      state = r._build_state
      // A non-evicting reconcile would stack a duplicate solid per rebuild.
      expect(elementsOfType(state!.checkpoints.f1, 'f1', 'solid')).toHaveLength(1)
      expect(resolveSolid(state!.checkpoints.f1, 'f1')).not.toBeNull()
    }
  })

  it('a body the loop could not register still gets exactly one solid in the checkpoint', () => {
    // The metadata extractor omits the body, so the loop never registers its faces;
    // the checkpoint pass recovers it. Before the reconcile that pass APPENDED a
    // second solid onto the one the loop already wrote (registerAncestor
    // accumulates), so `[@f1]` held two identical solids and `?@f1:solid` threw
    // AmbiguousQueryError on the live repo.
    const h = new Harness({ metaOmits: ['body_f1'] })
    const cold = h.run({ features: [{ id: 'f1', kind: 'make' }] })
    expect(elementsOfType(cold._build_state!.checkpoints.f1, 'f1', 'solid')).toHaveLength(1)
    expect(elementsOfType(cold._build_state!.checkpoints.f1, 'f1', 'extrusion-feature')).toHaveLength(1)
    expect(resolveSolid(cold._build_state!.checkpoints.f1, 'f1')).not.toBeNull()
  })

  it('a feature owning several bodies registers exactly one solid per body', () => {
    const multi = {
      features: [{
        id: 'f1', kind: 'make', label: 'multi',
        body_ids: ['body_f1', 'body_f1_1'],
      }],
    }
    const solveMulti = (
      feature: Record<string, unknown>,
      _repo: Repository,
      bodyStore: Record<string, Body>,
    ): FeatureResult => {
      const fid = String(feature.id ?? '')
      bodyStore['body_' + fid] = makeBody(fid, SHAPE_SEED[fid] ?? 1000, { id: 'body_' + fid })
      bodyStore['body_' + fid + '_1'] = makeBody(fid, (SHAPE_SEED[fid] ?? 1000) + 1, { id: 'body_' + fid + '_1' })
      return { status: 'ok' }
    }
    const deps: BuildDeps = {
      trySolveFeature: solveMulti,
      postRegister,
      initGlobalRepo: () => new Repository(),
      tessellateBodies: (store: Record<string, Body>) =>
        Object.fromEntries(Object.entries(store).map(([bid, b]) => [bid, fakeMeta(b)])),
      extractBrepMetadata: (store: Record<string, Body>) =>
        Object.fromEntries(Object.entries(store).map(([bid, b]) => [bid, fakeMeta(b)])),
      brepDiffNewFaceHashes: () => new Set<string>(),
      brepDiffNewEdgeHashes: () => new Set<string>(),
      brepDiffNewVertexHashes: () => new Set<string>(),
    }
    const cold = build(multi, { prevState: null }, deps)
    const coldSolids = elementsOfType(cold._build_state!.checkpoints.f1, 'f1', 'solid')
    expect(coldSolids.map((el) => (el as { body_id: string }).body_id).sort())
      .toEqual(['body_f1', 'body_f1_1'])

    // A re-solve must not grow the entry (4 solids) nor drop to 1. The changed
    // label makes findFirstDirty return 0 so the feature really re-solves.
    const again = build(
      { features: [{ id: 'f1', kind: 'make', label: 'multi v2', body_ids: ['body_f1', 'body_f1_1'] }] },
      { prevState: cold._build_state },
      deps,
    )
    const againSolids = elementsOfType(again._build_state!.checkpoints.f1, 'f1', 'solid')
    expect(againSolids.map((el) => (el as { body_id: string }).body_id).sort())
      .toEqual(['body_f1', 'body_f1_1'])
  })

  it('a null-shape owned body contributes no phantom solid under [@f1]', () => {
    // The solve loop only registers solids for bodies with `body.shape != null`
    // (the shaped-body guard in the solve loop), so a body whose geometry never
    // materialized is invisible to `?@fid:solid`. The reconcile must not
    // re-introduce it: before the guard it registered a phantom solid for the
    // null-shape body, inflating `[@f1]` to two solids and making
    // `?@f1:solid` throw AmbiguousQueryError. The two phantom solids are
    // genuinely distinct payloads (`_dedupeRepo` at builder.ts:234 collapses only
    // byte-identical payloads and they differ by `body_id`), so the repo holds 2
    // solids and the restore keeps both.
    const cold = buildNullShapePair(true)
    const cp = cold._build_state!.checkpoints.f1
    const solids = elementsOfType(cp, 'f1', 'solid')
    expect(solids).toHaveLength(1)
    expect((solids[0] as { body_id: string }).body_id).toBe('body_f1')
    expect(elementsOfType(cp, 'f1', 'extrusion-feature')).toHaveLength(1)
    const solid = resolveSolid(cp, 'f1')
    expect(solid).not.toBeNull()
    expect(solid!.body_id).toBe('body_f1')
  })

  it('the null-shape pair harness with every shape materialized keeps one solid per body', () => {
    // Control for the null-shape case: the same two-body solve, with the second
    // body's shape non-null, must keep the existing one-solid-per-body pin.
    const cold = buildNullShapePair(false)
    const cp = cold._build_state!.checkpoints.f1
    const solids = elementsOfType(cp, 'f1', 'solid')
    expect(solids.map((el) => (el as { body_id: string }).body_id).sort())
      .toEqual(['body_f1', 'body_f1_null'])
    expect(elementsOfType(cp, 'f1', 'extrusion-feature')).toHaveLength(1)
  })

  it('a partial rebuild keeps the creator solid while the modifier re-solves', () => {
    const h = new Harness()
    const spec = { features: [{ id: 'f1', kind: 'make' }, { id: 'f2', kind: 'modify', target: 'body_f1' }] }
    const cold = h.run(spec)
    expect(elementsOfType(cold._build_state!.checkpoints.f2, 'f1', 'solid')).toHaveLength(1)

    // Edit f2 (the modifier): f1 is the clean prefix, its solid comes back from the
    // checkpoint and must stay resolvable through the re-solved tail.
    const partial = h.run(
      { features: [{ id: 'f1', kind: 'make' }, { id: 'f2', kind: 'modify', target: 'body_f1', label: 'renamed' }] },
      cold._build_state,
    )
    expect(elementsOfType(partial._build_state!.checkpoints.f2, 'f1', 'solid')).toHaveLength(1)
    expect(resolveSolid(partial._build_state!.checkpoints.f2, 'f1')).not.toBeNull()
  })
})

// The two suites below stub postRegister (no wipe), so they can plant the exact
// live-repo state the reconcile has to clean up: a dead eid in `[@fid]` (nit 12)
// and a feature owning no shaped body (nit 13 early-exit). The live repo is
// captured through `initGlobalRepo` like the parity suite.
function entryUnder(liveRepo: Repository, fid: string): { set: Set<string>; eids: string[] } | undefined {
  return [...liveRepo.ancestral.values()].find((e) => e.set.size === 1 && e.set.has('@' + fid))
}

describe('reconcile hardening: the evict drops dead eids', () => {
  it('an eid whose element was deleted is not carried forward by the reconcile', () => {
    const liveRepo = new Repository()
    const deps: BuildDeps = {
      trySolveFeature: (feature, repo, bodyStore) => {
        const fid = String(feature.id ?? '')
        bodyStore['body_' + fid] = makeBody(fid, SHAPE_SEED[fid] ?? 1000)
        // Plant the supported dangling-eid state (the kind clearBySketchId leaves):
        // register under `[@fid]`, then delete the element without pruning the entry.
        const eid = repo.registerAncestor(['@' + fid], { type: 'sketch-feature', feature_id: fid })
        repo.deleteElement(eid)
        return { status: 'ok' }
      },
      postRegister: () => {},
      initGlobalRepo: () => liveRepo,
      tessellateBodies: () => ({}),
      extractBrepMetadata: () => ({}),
      brepDiffNewFaceHashes: () => new Set<string>(),
      brepDiffNewEdgeHashes: () => new Set<string>(),
      brepDiffNewVertexHashes: () => new Set<string>(),
    }
    build({ features: [{ id: 'f1', kind: 'make' }] }, { prevState: null }, deps)

    const entry = entryUnder(liveRepo, 'f1')
    expect(entry).toBeDefined()
    // Every eid the entry still lists resolves to a live element: the dead one was
    // dropped by the evict, not kept for `liveEntryEids` to filter at query time.
    expect(entry!.eids.every((eid) => liveRepo.elements.has(eid))).toBe(true)
    const solids = entry!.eids
      .map((eid) => liveRepo.elements.get(eid) as Record<string, unknown> | undefined)
      .filter((el) => el?.type === 'solid')
    expect(solids).toHaveLength(1)
    expect(solids[0]).toMatchObject({ body_id: 'body_f1', created_by: 'f1' })
  })
})

describe('reconcile hardening: no-body features exit early', () => {
  it('a feature owning no body registers no solid while an owning feature keeps exactly one', () => {
    const liveRepo = new Repository()
    const deps: BuildDeps = {
      trySolveFeature: (feature, _repo, bodyStore) => {
        const fid = String(feature.id ?? '')
        if (feature.kind === 'make') bodyStore['body_' + fid] = makeBody(fid, SHAPE_SEED[fid] ?? 1000)
        return { status: 'ok' }
      },
      postRegister: () => {},
      initGlobalRepo: () => liveRepo,
      tessellateBodies: () => ({}),
      extractBrepMetadata: () => ({}),
      brepDiffNewFaceHashes: () => new Set<string>(),
      brepDiffNewEdgeHashes: () => new Set<string>(),
      brepDiffNewVertexHashes: () => new Set<string>(),
    }
    build(
      { features: [{ id: 'sk1', kind: 'sketch' }, { id: 'f1', kind: 'make' }] },
      { prevState: null },
      deps,
    )

    const entry = entryUnder(liveRepo, 'f1')
    expect(entry).toBeDefined()
    const solidBodies = entry!.eids
      .map((eid) => liveRepo.elements.get(eid) as Record<string, unknown> | undefined)
      .filter((el) => el?.type === 'solid')
      .map((el) => el!.body_id)
      .sort()
    expect(solidBodies).toEqual(['body_f1'])

    // sk1 owns no body, so its reconcile early-exits and `[@sk1]` carries no solid.
    const skEntry = entryUnder(liveRepo, 'sk1')
    const skSolids = (skEntry?.eids ?? [])
      .map((eid) => liveRepo.elements.get(eid) as Record<string, unknown> | undefined)
      .filter((el) => el?.type === 'solid')
    expect(skSolids).toHaveLength(0)
    expect(liveRepo.query(makeAncestryQuery(['@sk1'], 'solid'))).toBeNull()
  })

  it('a feature owning only a null-shape body registers no solid under [@fid]', () => {
    const liveRepo = new Repository()
    const deps: BuildDeps = {
      trySolveFeature: (feature, _repo, bodyStore) => {
        const fid = String(feature.id ?? '')
        bodyStore['body_' + fid] = { ...makeBody(fid, SHAPE_SEED[fid] ?? 1000), shape: null }
        return { status: 'ok' }
      },
      postRegister: () => {},
      initGlobalRepo: () => liveRepo,
      tessellateBodies: () => ({}),
      extractBrepMetadata: () => ({}),
      brepDiffNewFaceHashes: () => new Set<string>(),
      brepDiffNewEdgeHashes: () => new Set<string>(),
      brepDiffNewVertexHashes: () => new Set<string>(),
    }
    build({ features: [{ id: 'f1', kind: 'make' }] }, { prevState: null }, deps)

    const skEntry = entryUnder(liveRepo, 'f1')
    const solids = (skEntry?.eids ?? [])
      .map((eid) => liveRepo.elements.get(eid) as Record<string, unknown> | undefined)
      .filter((el) => el?.type === 'solid')
    expect(solids).toHaveLength(0)
    expect(liveRepo.query(makeAncestryQuery(['@f1'], 'solid'))).toBeNull()
  })
})

// ─── real OCC: the production pipeline end to end ───

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('real OCC: a cosmetic re-solve keeps the solid', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('editing an extrude label leaves ?@ex1:solid resolving with the solid in the checkpoint', () => {
    const sk1 = rectSketch('sk1', 10, 10)
    const ex1 = { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new', label: 'orig' }
    const r1 = h.run({ features: [sk1, ex1] })
    expect((r1.result as Record<string, Record<string, unknown>>).ex1.status).toBe('ok')
    expect(elementsOfType(r1._build_state!.checkpoints.ex1, 'ex1', 'solid')).toHaveLength(1)
    expect(resolveSolid(r1._build_state!.checkpoints.ex1, 'ex1')).not.toBeNull()

    const ex1v2 = { ...ex1, label: 'renamed' }
    const r2 = h.run({ features: [sk1, ex1v2] }, { prevState: r1._build_state })
    expect((r2.result as Record<string, Record<string, unknown>>).ex1.status).toBe('ok')
    const cp = r2._build_state!.checkpoints.ex1
    expect(elementsOfType(cp, 'ex1', 'solid')).toHaveLength(1)
    expect(elementsOfType(cp, 'ex1', 'extrusion-feature')).toHaveLength(1)
    const solid = resolveSolid(cp, 'ex1')
    expect(solid).not.toBeNull()
    expect(solid!.body_id).toBe('body_ex1')
  })
})

