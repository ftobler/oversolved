import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { solveAssembly } from './solveAssembly'
import { bundleCachePut, bundleCacheGet } from './bundleCache'
import {
  makeRelay, makeBundle, translationTransform, identityTransform, makeEchoSolver, freshDb,
} from './solveAssemblyTestUtils'

// Wraps the real bundleCache functions in spies (delegating to the actual
// implementations) so tests can assert call counts or force rejections without
// disturbing the fake-indexeddb-backed behaviour every other test relies on.
vi.mock('./bundleCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bundleCache')>()
  return {
    ...actual,
    bundleCacheGet: vi.fn(actual.bundleCacheGet),
    bundleCachePut: vi.fn(actual.bundleCachePut),
  }
})

beforeEach(() => { freshDb() })

describe('solveAssembly', () => {
  // ─── mateless / cache-hit branch ───

  it('echoes transforms for a mateless doc with cache hit', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    const bundle = makeBundle('doc-a', '3')
    await bundleCachePut(bundle)

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: translationTransform(1, 2, 3) },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '3' }, [], relay, makeEchoSolver())

    expect(result.transforms).toEqual({ p1: translationTransform(1, 2, 3) })
    expect(result.bodies).toHaveProperty('p1')
    expect(result.bodies['p1']).toHaveLength(1)
    expect(result.status.mates).toEqual({})
    // No relay calls since cache hit
    expect(vi.mocked(relay.requestPartDoc)).not.toHaveBeenCalled()
  })

  it('calls relay on bundle cache miss', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
    ]
    await solveAssembly(parts, { 'doc-a': '3' }, [], relay, makeEchoSolver())

    expect(relay.requestPartDoc).toHaveBeenCalledWith('doc-a')
    expect(relay.requestBuildBundle).toHaveBeenCalledWith('doc-a', '3', { kind: 'part', features: [] })
  })

  it('uses bundle cache on second solve (no relay calls)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
    ]

    // First solve: cache miss, relay called
    await solveAssembly(parts, { 'doc-a': '3' }, [], relay, makeEchoSolver())
    expect(relay.requestPartDoc).toHaveBeenCalledTimes(1)

    const callCount = vi.mocked(relay.requestPartDoc).mock.calls.length

    // Second solve: cache hit, no relay
    await solveAssembly(parts, { 'doc-a': '3' }, [], relay, makeEchoSolver())
    expect(vi.mocked(relay.requestPartDoc).mock.calls.length).toBe(callCount)
  })

  it('bumps rev triggers single bundle rebuild per part', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })

    // Pre-cache doc-a at rev 3
    await bundleCachePut(makeBundle('doc-a', '3'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: identityTransform() },
    ]
    const revs = { 'doc-a': '4', 'doc-b': '1' }  // doc-a has updated

    await solveAssembly(parts, revs, [], relay, makeEchoSolver())

    // doc-a: cache miss at rev 4, relay called for part doc + build bundle
    // doc-b: cache miss at rev 1, relay called too
    expect(relay.requestPartDoc).toHaveBeenCalledWith('doc-a')
    expect(relay.requestPartDoc).toHaveBeenCalledWith('doc-b')
  })

  it('a big hash jump issues exactly one get and no migration lookup', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', '3'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
    ]

    vi.mocked(bundleCacheGet).mockClear()

    await solveAssembly(parts, { 'doc-a': '800' }, [], relay, makeEchoSolver())

    // One get for the top-of-loop cache-hit check at the current content hash (a
    // miss). The retired latest-rev lookup is gone, so there is no second read.
    expect(vi.mocked(bundleCacheGet).mock.calls).toEqual([
      ['doc-a', '800'],
    ])
  })

  it('rebuilds a cached bundle whose bodies lack entityAnchors (pre-Stage-7 cache)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    // Cache a bundle deliberately missing entityAnchors on every body.
    const stale = makeBundle('doc-a', '3', {
      bodies: [{
        mesh: {
          vertices: new Float32Array([0, 0, 0]),
          indices: new Uint32Array([]),
          faceIdsPerTriangle: new Uint32Array([]),
        },
        edges: [],
      }],
    })
    await bundleCachePut(stale)

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
    ]
    await solveAssembly(parts, { 'doc-a': '3' }, [], relay, makeEchoSolver())

    // The stale cache should force a rebuild: relay is called.
    expect(relay.requestPartDoc).toHaveBeenCalledWith('doc-a')
    expect(relay.requestBuildBundle).toHaveBeenCalledWith('doc-a', '3', expect.any(Object))
  })
})
