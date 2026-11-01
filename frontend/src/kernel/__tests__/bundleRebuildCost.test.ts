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
// Timings are next door in `bundleRebuildCostBenchReal.test.ts` (log-only); the
// numbers are recorded in `feature/knowledgebase.agent.md`.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { solveAssembly } from '../solveAssembly'
import { bundleCachePut, resetBundleDbConnection } from '../bundleCache'
import { BUNDLE_SCHEMA, type PartBundle } from '../partBundle'
import type { RelayService } from '../worker/solverProtocol'
import { identity } from '@/__tests__/fixtures'

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
// ─── what that actually buys, at the engine ───
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
