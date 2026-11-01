// @vitest-environment node
//
// Guards for the assembly side of the bundle-rev invalidation question: after a
// part document's rev bumps, only the part whose rev moved is rebuilt. That is
// what keeps a realistic assembly on the warm side of the engine's one-slot
// document cache. The engine half (the incremental bundle rebuild and the
// doc-id cache reset) is in bundleRebuildCostReal.test.ts; the timing sweep is
// bundleRebuildCostBenchReal.test.ts (log-only), and the numbers are recorded
// in `feature/knowledgebase.agent.md`.

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
// ─── the assembly-side rev guard ───
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
