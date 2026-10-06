// @vitest-environment node
//
// Guards for the bundle-rev invalidation question: when an assembly re-solves
// after a part document's rev bumped, how much of that part's feature stack is
// rebuilt?
//
// The premise this file was written to check turned out to be false, so what it
// pins is the corrected one. `handleBundleRequest` calls the engine as
// `solve(spec, {})`, and `{}` does NOT mean "no prevState": `solveLocally`
// reads `options.prevState !== undefined ? options.prevState : lastBuildState`,
// so an absent key falls back to the engine's own last build state. The bundle
// path therefore rebuilds incrementally exactly like the part editor -- until
// the engine sees a different `spec.id`, which trips `resetLocalSolveCache` and
// makes the next build of either document cold.
//
// The bundle spec reaches the engine WITH that id: `useAssemblySolve`'s relay
// stamps it on (`{ ...spec, id: doc_id }`) before the request crosses to the
// worker, so the guard above is live on the bundle path and not just the
// editor's.
//
// So the cost is not "the bundle path is cold", it is "the engine caches one
// document at a time". Both halves are pinned below, plus the assembly-side
// guard that only the part whose rev moved is rebuilt -- that is what keeps a
// realistic assembly on the warm side of the one-slot cache.
//
// That `{}` argument is pinned where it is written, in
// `worker/solverWorker.test.ts` ("passes spec and options to the engine"),
// which asserts the whole options object; this file starts from its
// consequences instead.
//
// Timings are next door in `bundleRebuildCostBench.test.ts` (log-only); the
// numbers are recorded in `feature/knowledgebase.agent.md`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { loadOcc } from '../occ/loadOcc'
import { solveLocally, setSolveLocalsForTest } from '../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { handleBundleRequest, handleSolveRequest } from '../worker/solverWorker'
import { solveAssembly } from '../solveAssembly'
import { bundleCachePut, resetBundleDbConnection } from '../bundleCache'
import { BUNDLE_SCHEMA, type PartBundle } from '../partBundle'
import type { BundleRequest } from '../worker/solverProtocol'
import type { RelayService } from '../worker/solverProtocol'
import { identity } from '@/__tests__/fixtures'

const oc = await loadOcc()
const solveBytes = loadSolver()

/**
 * The production bundle request shape: the raw PartDoc YAML (`part` carries no
 * id, as `partDocContent` returns it) plus the doc id the relay stamps on
 * (`useAssemblySolve`'s `{ ...spec, id: doc_id }`). `doc_id` is passed
 * separately, as the wire protocol carries it -- the two only ever match by
 * construction.
 */
function bundleReq(doc_id: string, content_hash: string, spec: Record<string, unknown>): BundleRequest {
  return { id: nextBundleId++, kind: 'buildBundle', spec: { ...spec, id: doc_id }, doc_id, content_hash }
}
let nextBundleId = 1

// ─── the assembly side: which parts get rebuilt at all ───

function stubBundle(doc_id: string, content_hash: string): PartBundle {
  return {
    doc_id,
    content_hash,
    schema: BUNDLE_SCHEMA,
    bodies: [{
      mesh: {
        vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        faceIdsPerTriangle: new Uint32Array([0]),
      },
      edges: [],
      entityAnchors: { faces: [], edges: [], vertices: [] },
    }],
    anchors: {},
  }
}

function stubRelay(): RelayService {
  return {
    requestPartDoc: vi.fn().mockResolvedValue({ kind: 'part', features: [] }),
    requestBuildBundle: vi.fn().mockImplementation(
      async (doc_id: string, content_hash: string) => stubBundle(doc_id, content_hash),
    ),
  }
}

describe('assembly bundle invalidation scope', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
  })

  it('builds nothing when every part is cached at its current rev', async () => {
    const relay = stubRelay()
    for (const doc of ['doc-a', 'doc-b', 'doc-c']) await bundleCachePut(stubBundle(doc, 'h3'))

    const parts = ['a', 'b', 'c'].map((s, i) => ({
      handle: `p${i}`, doc_id: `doc-${s}`, transform: identity(),
    }))
    await solveAssembly(parts, { 'doc-a': 'h3', 'doc-b': 'h3', 'doc-c': 'h3' }, [], relay, null)

    expect(relay.requestBuildBundle).not.toHaveBeenCalled()
  })

  it('rebuilds exactly the one part whose rev moved, not all N', async () => {
    const relay = stubRelay()
    for (const doc of ['doc-a', 'doc-b', 'doc-c']) await bundleCachePut(stubBundle(doc, 'h3'))

    const parts = ['a', 'b', 'c'].map((s, i) => ({
      handle: `p${i}`, doc_id: `doc-${s}`, transform: identity(),
    }))
    await solveAssembly(parts, { 'doc-a': 'h3', 'doc-b': 'h4', 'doc-c': 'h3' }, [], relay, null)

    // One rebuild, and it is doc-b's. This is what keeps the engine's one-slot
    // document cache warm across a user's edit loop: with a single miss per
    // solve, spec.id never changes and the incremental path survives.
    expect(relay.requestBuildBundle).toHaveBeenCalledTimes(1)
    expect(relay.requestBuildBundle).toHaveBeenCalledWith('doc-b', 'h4', { kind: 'part', features: [] })
  })
})

// ─── what that actually buys, at the engine ───

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c8', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c9', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

/** One sketch plus three pads; the last pad's distance is the edit. No `id`,
 *  as the store hands the relay raw PartDoc YAML -- the relay stamps it on. */
function part(lastDistance: number): Record<string, unknown> {
  return {
    features: [
      rectSketch('sk1', 20, 20),
      { id: 'ex0', kind: 'extrude', sketch: '$sk1', distance: 3, direction: 'normal', operation: 'add' },
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 4, direction: 'normal', operation: 'add' },
      { id: 'ex2', kind: 'extrude', sketch: '$sk1', distance: lastDistance, direction: 'normal', operation: 'add' },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('bundle builds through the real engine', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  /**
   * Wraps the production engine so a test can see the `_build_state` that
   * `handleBundleRequest` strips off. Checkpoint reuse is reference identity:
   * `build()` hands back the *same* FeatureCheckpoint object for a clean
   * prefix, so `===` distinguishes reuse from rebuild (same discriminator as
   * `solveLocalCache.test.ts`).
   */
  function recordingEngine(): { engine: typeof solveLocally; checkpoints: Record<string, unknown>[] } {
    const checkpoints: Record<string, unknown>[] = []
    const engine: typeof solveLocally = async (spec, options) => {
      const r = await solveLocally(spec, options)
      if (r) checkpoints.push((r._build_state.checkpoints ?? {}) as Record<string, unknown>)
      return r
    }
    return { engine, checkpoints }
  }

  it('reuses the clean prefix across two bundle builds of the same document', async () => {
    const { engine, checkpoints } = recordingEngine()
    await handleBundleRequest(bundleReq('doc-warm', 'h1', part(5)), engine)
    const res = await handleBundleRequest(bundleReq('doc-warm', 'h2', part(9)), engine)

    expect(res.ok).toBe(true)
    const [first, second] = checkpoints
    // sk1/ex0/ex1 are untouched by the edit and must come back as the same
    // objects: the rev bump did not cost a stack rebuild.
    expect(second.sk1).toBe(first.sk1)
    expect(second.ex0).toBe(first.ex0)
    expect(second.ex1).toBe(first.ex1)
    expect(second.ex2).not.toBe(first.ex2)
  })

  it('a different-doc bundle build resets the engine cache (zero checkpoint reuse)', async () => {
    // Two consecutive bundle builds of DIFFERENT docs: solveLocally's doc-keyed
    // reset fires on the second, so it rebuilds every feature instead of reusing
    // doc-x's clean prefix. This guard used to be dead on the bundle path (raw
    // specs carried no id); the relay stamps it on, and the stamp is what the
    // request under test carries.
    const { engine, checkpoints } = recordingEngine()
    await handleBundleRequest(bundleReq('doc-x', 'h1', part(5)), engine)
    const res = await handleBundleRequest(bundleReq('doc-y', 'h1', part(5)), engine)

    expect(res.ok).toBe(true)
    const [first, second] = checkpoints
    expect(second.sk1).not.toBe(first.sk1)
    expect(second.ex0).not.toBe(first.ex0)
    expect(second.ex1).not.toBe(first.ex1)
  })

  it('goes cold when another document is built in between', async () => {
    const { engine, checkpoints } = recordingEngine()
    await handleBundleRequest(bundleReq('doc-x', 'h1', part(5)), engine)
    await handleBundleRequest(bundleReq('doc-y', 'h1', part(5)), engine)
    const res = await handleBundleRequest(bundleReq('doc-x', 'h2', part(9)), engine)

    expect(res.ok).toBe(true)
    const first = checkpoints[0]
    const third = checkpoints[2]
    // The engine caches one document at a time (`resetLocalSolveCache` on a
    // spec.id change), so doc-x's second build rebuilds every feature. This is
    // the entire measured cost of the bundle path.
    expect(third.sk1).not.toBe(first.sk1)
    expect(third.ex0).not.toBe(first.ex0)
    expect(third.ex1).not.toBe(first.ex1)
  })

  it('a bundle build of another part evicts the part editor cache', async () => {
    // `worker/solverClient.ts` holds ONE module-level worker, and both
    // `solveViaWorker` (part editor) and `buildBundleViaWorker` (assembly)
    // route through it, so the one cache slot is shared across the two pages
    // of the SPA -- an assembly bundle build for doc-q makes the next part
    // editor solve of doc-p cold. That is a wider blast radius than "two parts
    // missed in the same assembly solve", which is why it gets its own case.
    const { engine, checkpoints } = recordingEngine()
    await handleSolveRequest({ id: 1, spec: { ...part(5), id: 'doc-p' }, options: {} }, engine)
    await handleBundleRequest(bundleReq('doc-q', 'h1', part(5)), engine)
    await handleSolveRequest({ id: 2, spec: { ...part(9), id: 'doc-p' }, options: {} }, engine)

    const [first, , third] = checkpoints
    expect(third.sk1).not.toBe(first.sk1)
    expect(third.ex0).not.toBe(first.ex0)
    expect(third.ex1).not.toBe(first.ex1)
  })
})
