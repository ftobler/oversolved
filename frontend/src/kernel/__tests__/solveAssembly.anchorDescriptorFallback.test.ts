import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { solveAssembly } from '../solveAssembly'
import { anchorIdFor, type PartBundle } from '../partBundle'
import { buildEntityMateRefs } from '../../utils/assemblyBodies'
import { assemblyEntityKey } from '../../utils/anchorCandidates'
import type { MateAnchorDescriptor } from '../../types/cad'
import type { RelayService } from '../worker/solverProtocol'
import {
  makeRelay, makeBundle, identityTransform, translationTransform, makeCaptureSolver,
  makeEchoSolver, freshDb,
} from '../solveAssemblyTestUtils'

beforeEach(() => { freshDb() })

describe('anchor descriptor fallback (C7)', () => {
  // A relay whose doc-a anchor is positional and moves with the rev: rev 1 sits
  // at [0,0,0], rev 2+ at [5,0,0]. Same created_by + kind, so after the move
  // only tier 2 can re-find it. Doc-b keeps makeBundle's default anchors.
  function relayWithMovingAnchor(relay: RelayService): void {
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, content_hash: string) => {
      if (doc_id === 'doc-a') {
        const x = Number(content_hash) >= 2 ? 5 : 0
        return makeBundle('doc-a', content_hash, {
          anchors: {
            aMoved: { kind: 'point', point: [x, 0, 0], axis: [0, 0, 1], geom_hash: `@gdf|x${x}`, created_by: 'feat1' },
          },
        })
      }
      return makeBundle('doc-b', content_hash)
    })
  }

  it('re-finds a moved element by descriptor after a cache wipe (required test 1)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    relayWithMovingAnchor(relay)

    const descriptor: MateAnchorDescriptor = {
      geom_hash: '@gdf|x0', kind: 'point', created_by: 'feat1', point: [0, 0, 0],
    }
    const mates = [{
      id: 'm1', kind: 'spherical',
      ref_a: { part: 'p1', anchor: anchorIdFor('@gdf|x0', 'point'), anchor_descriptor: descriptor },
      ref_b: { part: 'p2', anchor: 'a2' },
    }]
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]

    // Rev 1 warms the cache. The mock keys the anchor `aMoved`, so the ref's
    // deterministic id misses the dict and anchorByGeomHash re-parents it onto
    // the geohash-identical anchor, which is the path this warm solve proves.
    const warm = makeCaptureSolver()
    const r1 = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, warm.solver)
    expect(r1.status.mates['m1'].stale).toBe(false)
    expect(warm.captured.input!.mates[0].pointA[0]).toBeCloseTo(0)

    // Wipe, then rebuild at the moved rev: the old id is gone and no cached
    // predecessor exists, so only the descriptor can re-find the element.
    freshDb()
    const cold = makeCaptureSolver()
    const r2 = await solveAssembly(parts, { 'doc-a': '2', 'doc-b': '1' }, mates, relay, cold.solver)
    expect(r2.status.mates['m1'].stale).toBe(false)
    expect(cold.captured.input!.mates[0].pointA[0]).toBeCloseTo(5)
  })

  it('stamps the deterministic id with its descriptor and the ref survives a later cache wipe', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })

    // A doc-a build whose single positional face anchor moves with the content
    // hash and whose entity index names that anchor, so the pick path can be
    // exercised.
    const movingFaceBundle = (doc_id: string, content_hash: string): PartBundle => {
      const x = Number(content_hash) >= 2 ? 5 : 0
      const geom = `@gdf|x${x}`
      const id = anchorIdFor(geom, 'point')
      return makeBundle(doc_id, content_hash, {
        bodies: [{
          mesh: {
            vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0]),
            indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
            faceIdsPerTriangle: new Uint32Array([0, 0]),
          },
          edges: [],
          entityAnchors: { faces: [[id]], edges: [], vertices: [] },
        }],
        anchors: { [id]: { kind: 'point', point: [x, 0, 0], axis: [0, 0, 1], geom_hash: geom, created_by: 'feat1' } },
      })
    }
    vi.mocked(relay.requestBuildBundle).mockImplementation(
      async (doc_id: string, content_hash: string) =>
        doc_id === 'doc-a' ? movingFaceBundle('doc-a', content_hash) : makeBundle('doc-b', content_hash),
    )

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const solved = await solveAssembly(parts, { 'doc-a': '2', 'doc-b': '1' }, [], relay, makeEchoSolver())

    // Anchor ids are deterministic from geom_hash, so the pick path stamps the
    // moved element's own id with its current descriptor; no remap seed exists
    // or is needed.
    const refs = buildEntityMateRefs(solved.bodies, solved.anchorDescriptors)
    const ref = refs[assemblyEntityKey('p1', 0, 'face', 0)][0]
    expect(ref.anchor).toBe(anchorIdFor('@gdf|x5', 'point'))
    expect(ref.anchor_descriptor).toEqual({
      geom_hash: '@gdf|x5', kind: 'point', created_by: 'feat1', point: [5, 0, 0],
    })

    // The stamped ref survives a cache wipe: the cold rebuild has the same
    // deterministic id, so the ref resolves with no cache at all.
    freshDb()
    const mates = [{
      id: 'm1', kind: 'spherical',
      ref_a: { part: 'p1', anchor: ref.anchor, anchor_descriptor: ref.anchor_descriptor },
      ref_b: { part: 'p2', anchor: 'a2' },
    }]
    const cold = makeCaptureSolver()
    const r2 = await solveAssembly(parts, { 'doc-a': '2', 'doc-b': '1' }, mates, relay, cold.solver)
    expect(r2.status.mates['m1'].stale).toBe(false)
    expect(cold.captured.input!.mates[0].pointA[0]).toBeCloseTo(5)
  })

  it('re-finds the named one of two same-kind anchors after a move (required test 2)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, content_hash: string) => {
      if (doc_id === 'doc-a') {
        const aX = Number(content_hash) >= 2 ? 5 : 0
        return makeBundle('doc-a', content_hash, {
          anchors: {
            aNamed: { kind: 'point', point: [aX, 0, 0], axis: [0, 0, 1], geom_hash: `@gdf|a${aX}`, created_by: 'feat1' },
            aSibling: { kind: 'point', point: [10, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|a10', created_by: 'feat1' },
          },
        })
      }
      return makeBundle('doc-b', content_hash)
    })

    const descriptor: MateAnchorDescriptor = {
      geom_hash: '@gdf|a0', kind: 'point', created_by: 'feat1', point: [0, 0, 0],
    }
    const mates = [{
      id: 'm1', kind: 'spherical',
      ref_a: { part: 'p1', anchor: anchorIdFor('@gdf|a0', 'point'), anchor_descriptor: descriptor },
      ref_b: { part: 'p2', anchor: 'a2' },
    }]
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]

    const warm = makeCaptureSolver()
    const r1 = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, warm.solver)
    expect(r1.status.mates['m1'].stale).toBe(false)
    expect(warm.captured.input!.mates[0].pointA[0]).toBeCloseTo(0)

    freshDb()
    const cold = makeCaptureSolver()
    const r2 = await solveAssembly(parts, { 'doc-a': '2', 'doc-b': '1' }, mates, relay, cold.solver)
    expect(r2.status.mates['m1'].stale).toBe(false)
    // The nearer moved aNamed, not the untouched aSibling at [10,0,0].
    expect(cold.captured.input!.mates[0].pointA[0]).toBeCloseTo(5)
  })

  it('refuses to rebind a descriptor whose @u| identity is gone (no silent rebind)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    // A same-kind, same-created_by positional candidate exists at [0,0,0]; a
    // fail-wrong resolver would bind the gone UUID to it. It must not.
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, content_hash: string) => {
      if (doc_id === 'doc-a') {
        return makeBundle('doc-a', content_hash, {
          anchors: {
            aCandidate: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|a0', created_by: 'feat1' },
          },
        })
      }
      return makeBundle('doc-b', content_hash)
    })

    const descriptor: MateAnchorDescriptor = {
      geom_hash: '@u|gone-uuid', kind: 'point', created_by: 'feat1', point: [0, 0, 0],
    }
    const mates = [{
      id: 'm1', kind: 'spherical',
      ref_a: { part: 'p1', anchor: 'a_gone', anchor_descriptor: descriptor },
      ref_b: { part: 'p2', anchor: 'a2' },
    }]
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]

    const result = await solveAssembly(parts, { 'doc-a': '2', 'doc-b': '1' }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_a')
  })

  it('leaves a legacy ref without a descriptor stale after a cache wipe and a moved geom_hash', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    relayWithMovingAnchor(relay)

    // No anchor_descriptor: go-forward-only, so a moved geom_hash strands it.
    const mates = [{
      id: 'm1', kind: 'spherical',
      ref_a: { part: 'p1', anchor: anchorIdFor('@gdf|x0', 'point') },
      ref_b: { part: 'p2', anchor: 'a2' },
    }]
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]

    const r1 = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, makeEchoSolver())
    expect(r1.status.mates['m1'].stale).toBe(false)

    freshDb()
    const r2 = await solveAssembly(parts, { 'doc-a': '2', 'doc-b': '1' }, mates, relay, makeEchoSolver())
    expect(r2.status.mates['m1'].stale).toBe(true)
    expect(r2.status.mates['m1'].staleRefs).toContain('ref_a')
  })
})
