// solveAssembly's coverage is split across the sibling solveAssembly*.test.ts
// files; this one holds the core orchestration and mate-solving cases.
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { solveAssembly } from '../solveAssembly'
import { bundleCachePut } from '../bundleCache'
import {
  makeRelay, makeBundle, makeAxialBundle, translationTransform, identityTransform,
  makeEchoSolver, makeCaptureSolver, makeTranslateSolver, makeScaledQwSolver, freshDb,
} from '../solveAssemblyTestUtils'

beforeEach(() => { freshDb() })

describe('solveAssembly', () => {
  // ─── mate solve branch ───

  it('solves a spherical mate between two parts', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })

    // Pre-cache bundles
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: translationTransform(0, 0, 0) },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'spherical',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: 'p2', anchor: 'a1' },
      },
    ]
    const revs = { 'doc-a': '1', 'doc-b': '1' }

    const result = await solveAssembly(parts, revs, mates, relay, makeEchoSolver())

    expect(result.transforms).toHaveProperty('p1')
    expect(result.transforms).toHaveProperty('p2')
    expect(result.bodies).toHaveProperty('p1')
    expect(result.bodies).toHaveProperty('p2')
    expect(result.status.mates).toHaveProperty('m1')
    expect(result.status.mates['m1'].stale).toBe(false)
    // No relay calls (both cache hits)
    expect(relay.requestPartDoc).not.toHaveBeenCalled()
  })

  it('encodes a fixed mate angle authored in degrees as radians on the wire', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeAxialBundle('doc-a', '1'))
    await bundleCachePut(makeAxialBundle('doc-b', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: translationTransform(0, 0, 0) },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'fixed',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: 'p2', anchor: 'a1' },
        angle: 90,
      },
    ]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    expect(captured.input!.mates[0].angle).toBeCloseTo(Math.PI / 2)
  })

  // The tolerant dual-read at the wire. A legacy document authored `offset: 7`
  // as a distance along A's anchor axis; the record now carries a vector, and
  // the scalar has to arrive as exactly that same displacement or every saved
  // assembly shifts. There is no document migration to lean on.
  it('expands a legacy scalar offset along the A anchor axis on the wire', async () => {
    const { relay } = makeRelay()
    await bundleCachePut(makeAxialBundle('doc-a', '1'))
    await bundleCachePut(makeAxialBundle('doc-b', '1'))
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: translationTransform(0, 0, 0) },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    // a1's axis is (0, 0, 1), so a scalar 7 is the vector (0, 0, 7).
    const mates = [{
      id: 'm1', kind: 'fixed',
      ref_a: { part: 'p1', anchor: 'a1' },
      ref_b: { part: 'p2', anchor: 'a1' },
      offset: 7,
    }]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    expect(captured.input!.mates[0].offset[0]).toBeCloseTo(0)
    expect(captured.input!.mates[0].offset[1]).toBeCloseTo(0)
    expect(captured.input!.mates[0].offset[2]).toBeCloseTo(7)
  })

  it('encodes a vector offset componentwise', async () => {
    const { relay } = makeRelay()
    await bundleCachePut(makeAxialBundle('doc-a', '1'))
    await bundleCachePut(makeAxialBundle('doc-b', '1'))
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: translationTransform(0, 0, 0) },
      { handle: 'p2', doc_id: 'doc-b', transform: translationTransform(5, 0, 0) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed',
      ref_a: { part: 'p1', anchor: 'a1' },
      ref_b: { part: 'p2', anchor: 'a1' },
      offset: { x: 3, z: -2 },  // y unnamed: it must land as 0, not drop the offset
    }]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, solver)

    expect(captured.input!.mates[0].offset[0]).toBeCloseTo(3)
    expect(captured.input!.mates[0].offset[1]).toBeCloseTo(0)
    expect(captured.input!.mates[0].offset[2]).toBeCloseTo(-2)
  })

  it('apply transforms to vertices', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform() },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1' }, [], relay, makeTranslateSolver(10))

    // With no mates the solver never runs; the part's own transform (identity)
    // passes through unchanged, so vertices land at identity too.
    const body = result.bodies['p1'][0]
    expect(body.vertices[0]).toBeCloseTo(0)
    expect(body.vertices[3]).toBeCloseTo(10)
  })

  it('normalizes a solved quaternion that is unit only to solver tolerance (qw = 1.02), leaving vertex distances from the origin unchanged', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))
    await bundleCachePut(makeBundle('doc-b', '1', {
      bodies: [{
        mesh: {
          vertices: new Float32Array([3, 4, 0, 0, 0, 5]),  // distances 5 and 5 from origin
          indices: new Uint32Array([]),
          faceIdsPerTriangle: new Uint32Array([]),
        },
        edges: [],
        entityAnchors: { faces: [], edges: [], vertices: [] },
      }],
    }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: identityTransform(), fixed: true },
      { handle: 'p2', doc_id: 'doc-b', transform: identityTransform() },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    // Body index 1 is p2 (p1 is index 0).
    const result = await solveAssembly(parts, { 'doc-a': '1', 'doc-b': '1' }, mates, relay, makeScaledQwSolver(1, 1.02))

    const t = result.transforms['p2']
    expect(Math.hypot(t.qx, t.qy, t.qz, t.qw)).toBeCloseTo(1, 6)

    const verts = result.bodies['p2'][0].vertices
    const dist0 = Math.hypot(verts[0], verts[1], verts[2])
    const dist1 = Math.hypot(verts[3], verts[4], verts[5])
    expect(dist0).toBeCloseTo(5, 5)
    expect(dist1).toBeCloseTo(5, 5)
  })
})
