import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { solveAssembly } from './solveAssembly'
import { bundleCacheGet, bundleCachePut } from './bundleCache'
import {
  makeRelay, makeBundle, identityTransform, translationTransform, makeEchoSolver, freshDb,
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
  // ─── error handling ───

  it('degrades a rejecting bundle cache read to the cold rebuild path and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { relay, partDocs } = makeRelay()
      partDocs.set('doc-a', { kind: 'part', features: [] })
      vi.mocked(bundleCacheGet).mockRejectedValueOnce(new Error('quota exceeded'))

      const parts = [
        { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      ]
      const result = await solveAssembly(parts, { 'doc-a': '3' }, [], relay, makeEchoSolver())

      // The solve itself succeeds via the relayed rebuild; an IndexedDB
      // failure must never surface as ok:false after that build was paid for.
      expect(result.transforms['p1']).toEqual(identityTransform())
      expect(result.bodies['p1']).toHaveLength(1)
      expect(relay.requestBuildBundle).toHaveBeenCalledWith('doc-a', '3', expect.any(Object))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('degrading to a miss')
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps the solved assembly when the bundle cache write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { relay, partDocs } = makeRelay()
      partDocs.set('doc-a', { kind: 'part', features: [] })
      vi.mocked(bundleCachePut).mockRejectedValueOnce(new Error('quota exceeded'))

      const parts = [
        { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      ]
      const result = await solveAssembly(parts, { 'doc-a': '3' }, [], relay, makeEchoSolver())

      expect(result.transforms['p1']).toEqual(identityTransform())
      expect(result.bodies['p1']).toHaveLength(1)
      // The write failure costs one cold rebuild later, not this solve.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('put failed')
    } finally {
      warn.mockRestore()
    }
  })

  it('degrades a rejected cache get to a cold rebuild without failing the solve', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { relay, partDocs } = makeRelay()
      partDocs.set('doc-a', { kind: 'part', features: [] })
      vi.mocked(bundleCacheGet).mockRejectedValueOnce(new Error('db closed'))

      const parts = [
        { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      ]
      const result = await solveAssembly(parts, { 'doc-a': '800' }, [], relay, makeEchoSolver())

      // The failed get is a miss, so the part cold-rebuilds; the solve succeeds.
      expect(result.transforms['p1']).toEqual(identityTransform())
      expect(relay.requestPartDoc).toHaveBeenCalledWith('doc-a')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('returns seed transforms when solver is null', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: translationTransform(1, 2, 3) },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1' }, [], relay, null)

    expect(result.transforms['p1']).toEqual(translationTransform(1, 2, 3))
    expect(result.status.verdict).toBe('none')
    expect(result.status.error).toBeUndefined()
  })

  it('reports an unavailable solver when solver is null but mates exist', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, null)

    expect(result.status.verdict).toBe('unavailable')
    expect(result.status.error).toContain('Mate solver not available.')
    // Scene still draws at the placed seeds.
    expect(result.transforms['p1']).toEqual(identityTransform())
    expect(result.transforms['p2']).toEqual(translationTransform(5, 0, 0))
  })

  it('handles empty parts array', async () => {
    const { relay } = makeRelay()
    const result = await solveAssembly([], {}, [], relay, makeEchoSolver())

    expect(result.transforms).toEqual({})
    expect(result.bodies).toEqual({})
    expect(result.status.mates).toEqual({})
  })
})
