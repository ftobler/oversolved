import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { solveAssembly } from '../solveAssembly'
import { bundleCachePut } from '../bundleCache'
import { anchorIdFor, BUNDLE_SCHEMA } from '../partBundle'
import {
  makeRelay, makeBundle, makeDeterministicBundle, identityTransform, translationTransform,
  makeEchoSolver, freshDb,
} from '../solveAssemblyTestUtils'

beforeEach(() => { freshDb() })

describe('solveAssembly', () => {
  // ─── stale ref detection ───

  it('flags a mate as stale when anchor is missing from bundle', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })

    const b2 = makeBundle('doc-b', '1')
    // Remove 'a1' from doc-b's anchors
    delete b2.anchors.a1
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(b2)

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'spherical',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: 'p2', anchor: 'a1' },  // missing from bundle
      },
    ]

    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_b')
  })

  it('flags a mate as stale when part is missing', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'spherical',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: 'p2', anchor: 'a1' },  // p2 not in parts array
      },
    ]

    const result = await solveAssembly(parts, { 'doc-a': '1' }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_b')
  })

  // ─── deterministic anchor ids + stale-bundle remap (cache-fallthrough) ───

  it('persisted mate refs survive a cache wipe + cold rebuild with no cache at all', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    // The relay cold-builds deterministic-id bundles, standing in for the
    // current production code.
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, content_hash: string) =>
      makeDeterministicBundle(doc_id, content_hash),
    )
    const idA = anchorIdFor('@gdf|0.000|0.000|0.000|0.000|0.000|1.000', 'point')
    const idB = anchorIdFor('@gdf|10.000|0.000|0.000|0.000|0.000|1.000', 'point')

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: idA }, ref_b: { part: 'p2', anchor: idB } },
    ]
    const revs = { 'doc-a': '1', 'doc-b': '1' }

    const r1 = await solveAssembly(parts, revs, mates, relay, makeEchoSolver())
    expect(r1.status.mates['m1'].stale).toBe(false)

    // A cache wipe strands the cached bundles; the cold rebuild must mint the
    // same deterministic ids, so the persisted refs still resolve.
    freshDb()
    const r2 = await solveAssembly(parts, revs, mates, relay, makeEchoSolver())
    expect(r2.status.mates['m1'].stale).toBe(false)
  })

  it('a schema-stale cache cold-rebuilds and the rebuilt bundle still resolves a deterministic ref', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, content_hash: string) =>
      makeDeterministicBundle(doc_id, content_hash),
    )
    // Both docs cached at the CURRENT content hash but under the OLD schema: the
    // top-of-loop get reads them as misses (cold rebuild). Anchor ids are
    // deterministic from geom_hash, so the rebuild mints the ids a persisted ref
    // already names; no remap seed exists or is needed.
    await bundleCachePut(makeBundle('doc-a', '1', { schema: BUNDLE_SCHEMA - 1 }))
    await bundleCachePut(makeBundle('doc-b', '1', { schema: BUNDLE_SCHEMA - 1 }))

    const idA = anchorIdFor('@gdf|0.000|0.000|0.000|0.000|0.000|1.000', 'point')
    const idB = anchorIdFor('@gdf|10.000|0.000|0.000|0.000|0.000|1.000', 'point')
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: idA }, ref_b: { part: 'p2', anchor: idB } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, makeEchoSolver())

    // The stale bundles were cold-rebuilt (relay called) and the deterministic
    // ids resolve, so the mate is not stale-red.
    expect(relay.requestPartDoc).toHaveBeenCalled()
    expect(result.status.mates['m1'].stale).toBe(false)
  })

  it('re-parents a ref holding a deterministic id onto the geometrically identical anchor when the dict was re-keyed', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    const g1 = '@gdf|0.000|0.000|0.000|0.000|0.000|1.000'
    const g2 = '@gdf|10.000|0.000|0.000|0.000|0.000|1.000'
    // The dicts are keyed by legacy random ids (a migration re-keyed them away
    // from the deterministic ids); the refs still hold the deterministic ids a
    // fresh build mints, so the direct lookup misses and the geom_hash fallback
    // must re-parent them to the geometrically identical anchors.
    await bundleCachePut(makeBundle('doc-a', '1', {
      anchors: { legacy: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: g1, created_by: 'feat1' } },
    }))
    await bundleCachePut(makeBundle('doc-b', '1', {
      anchors: { legacy: { kind: 'point', point: [10, 0, 0], axis: [0, 0, 1], geom_hash: g2, created_by: 'feat1' } },
    }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      {
        id: 'm1', kind: 'spherical',
        ref_a: { part: 'p1', anchor: anchorIdFor(g1, 'point') },
        ref_b: { part: 'p2', anchor: anchorIdFor(g2, 'point') },
      },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1'].stale).toBe(false)
  })

  it('refuses the geom_hash fallback when two anchors hash to one id (tier-1 collision)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    const g1 = '@gdf|0.000|0.000|0.000|0.000|0.000|1.000'
    const g2 = '@gdf|10.000|0.000|0.000|0.000|0.000|1.000'
    // Two anchors in one bundle share the same geom_hash + kind: both recompute
    // to the same deterministic id, so the fallback must refuse to re-parent
    // rather than pick one of two elements for a single stale id.
    await bundleCachePut(makeBundle('doc-a', '1', {
      anchors: {
        legacyA: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: g1, created_by: 'feat1' },
        legacyB: { kind: 'point', point: [5, 0, 0], axis: [0, 0, 1], geom_hash: g1, created_by: 'feat1' },
      },
    }))
    await bundleCachePut(makeBundle('doc-b', '1', {
      anchors: { legacy: { kind: 'point', point: [10, 0, 0], axis: [0, 0, 1], geom_hash: g2, created_by: 'feat1' } },
    }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      {
        id: 'm1', kind: 'spherical',
        ref_a: { part: 'p1', anchor: anchorIdFor(g1, 'point') },
        ref_b: { part: 'p2', anchor: anchorIdFor(g2, 'point') },
      },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_a')
  })

  it('does not re-parent a stale random id onto an unrelated anchor (deleted element stays stale)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    // A pre-deterministic mate ref (random id) whose element is genuinely gone:
    // no bundle anchor recomputes to it, so it stays stale-red instead of
    // re-parenting onto an unrelated anchor.
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'legacyRandomId' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_a')
  })
})
