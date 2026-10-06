import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { solveAssembly } from '../solveAssembly'
import { bundleCachePut } from '../bundleCache'
import { sampleEdgeCurve } from '../../utils/edgeSampling'
import {
  makeRelay, makeBundle, translationTransform, identityTransform, makeEchoSolver, freshDb,
} from '../solveAssemblyTestUtils'

beforeEach(() => { freshDb() })

describe('solveAssembly', () => {
  // ─── edge curves ───

  it('carries the bundle edge curves into the payload in the solved pose', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    // A line along +X and a circle in the z=0 plane, both at the part origin.
    await bundleCachePut(makeBundle('doc-a', '1', {
      bodies: [{
        mesh: {
          vertices: new Float32Array([0, 0, 0]),
          indices: new Uint32Array([]),
          faceIdsPerTriangle: new Uint32Array([]),
        },
        edges: [
          {
            id: 'e_line', kind: 'line', point: [1, 0, 0], axis: [1, 0, 0],
            endpoints: [[0, 0, 0], [2, 0, 0]],
          },
          {
            id: 'e_circle', kind: 'circle', point: [0, 0, 0], axis: [0, 0, 1], radius: 5,
            x_axis: [1, 0, 0], angle_start: 0, angle_end: 2 * Math.PI,
            endpoints: [[5, 0, 0], [5, 0, 0]],
          },
        ],
        entityAnchors: { faces: [], edges: [], vertices: [] },
      }],
    }))

    // 90° about +Z, then lifted 3 in z. No mates, so the placed transform is
    // echoed straight back and the edges must land under exactly it.
    const s = Math.SQRT1_2
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: { tx: 0, ty: 0, tz: 3, qx: 0, qy: 0, qz: s, qw: s } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1' }, [], relay, makeEchoSolver())

    const [lineCurve, circleCurve] = result.bodies['p1'][0].edges
    // Points take the rotation and the translation.
    expect(lineCurve.endpoints[0][0]).toBeCloseTo(0)
    expect(lineCurve.endpoints[0][2]).toBeCloseTo(3)
    expect(lineCurve.endpoints[1][0]).toBeCloseTo(0)
    expect(lineCurve.endpoints[1][1]).toBeCloseTo(2)
    expect(lineCurve.endpoints[1][2]).toBeCloseTo(3)
    // Directions take the rotation only: +X becomes +Y, with no z offset.
    expect(lineCurve.axis![0]).toBeCloseTo(0)
    expect(lineCurve.axis![1]).toBeCloseTo(1)
    expect(lineCurve.axis![2]).toBeCloseTo(0)

    // A rigid motion leaves radius and sweep alone, that is what keeps the
    // curve analytic instead of forcing a re-fit.
    expect(circleCurve.radius).toBe(5)
    expect(circleCurve.angle_end).toBeCloseTo(2 * Math.PI)
    expect(circleCurve.x_axis![1]).toBeCloseTo(1)  // rotated with the body
    expect(circleCurve.axis![2]).toBeCloseTo(1)    // spin axis unchanged by a spin about it
    expect(circleCurve.point[2]).toBeCloseTo(3)    // center lifted
  })

  it('keeps a transformed curve samplable: the arc still lands on its moved endpoints', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1', {
      bodies: [{
        mesh: {
          vertices: new Float32Array([0, 0, 0]),
          indices: new Uint32Array([]),
          faceIdsPerTriangle: new Uint32Array([]),
        },
        edges: [
          {
            id: 'e_arc', kind: 'circle', point: [0, 0, 0], axis: [0, 0, 1], radius: 5,
            x_axis: [1, 0, 0], angle_start: 0, angle_end: Math.PI / 2,
            endpoints: [[5, 0, 0], [0, 5, 0]],
          },
          {
            id: 'e_spline', kind: 'b-spline', point: [1, 1, 0],
            endpoints: [[0, 0, 0], [2, 0, 0]],
            points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]],
          },
        ],
        entityAnchors: { faces: [], edges: [], vertices: [] },
      }],
    }))

    const s = Math.SQRT1_2  // 90° about +Z, lifted 3 in z
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: { tx: 0, ty: 0, tz: 3, qx: 0, qy: 0, qz: s, qw: s } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1' }, [], relay, makeEchoSolver())
    const [arc, splineCurve] = result.bodies['p1'][0].edges

    // Sampling and transforming compose: the polyline drawn in world space still
    // begins and ends exactly on the curve's own transformed endpoints, and every
    // interior point stays on the analytic arc. This is the invariant that lets
    // the worker bake the pose and the viewport sample it independently.
    const pts = sampleEdgeCurve(arc, 16)
    pts[0].forEach((v, i) => expect(v).toBeCloseTo(arc.endpoints[0][i], 5))
    pts[pts.length - 1].forEach((v, i) => expect(v).toBeCloseTo(arc.endpoints[1][i], 5))
    for (const p of pts) {
      expect(Math.hypot(p[0] - arc.point[0], p[1] - arc.point[1])).toBeCloseTo(5, 5)
      expect(p[2]).toBeCloseTo(3, 5)  // the whole arc rides the lifted plane
    }

    // A spline has no analytic form to re-derive, so its tessellated interior
    // must be carried into the pose point by point.
    expect(splineCurve.points).toHaveLength(3)
    expect(splineCurve.points![1][0]).toBeCloseTo(-1)  // (1,1,0) rotated 90° about +Z
    expect(splineCurve.points![1][1]).toBeCloseTo(1)
    expect(splineCurve.points![1][2]).toBeCloseTo(3)
    expect(sampleEdgeCurve(splineCurve)).toEqual(splineCurve.points)
  })

  it('gives two instances of one part independently posed edges', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1', {
      bodies: [{
        mesh: {
          vertices: new Float32Array([0, 0, 0]),
          indices: new Uint32Array([]),
          faceIdsPerTriangle: new Uint32Array([]),
        },
        edges: [{
          id: 'e_line', kind: 'line', point: [1, 0, 0], axis: [1, 0, 0],
          endpoints: [[0, 0, 0], [2, 0, 0]],
        }],
        entityAnchors: { faces: [], edges: [], vertices: [] },
      }],
    }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: translationTransform(100, 0, 0) },
      { handle: 'p2', doc_id: 'doc-a', transform: translationTransform(-100, 0, 0) },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1' }, [], relay, makeEchoSolver())

    // One bundle, two poses: the shared source must not leak one part's pose
    // into the other.
    expect(result.bodies['p1'][0].edges[0].endpoints[0][0]).toBeCloseTo(100)
    expect(result.bodies['p2'][0].edges[0].endpoints[0][0]).toBeCloseTo(-100)
  })

  // ─── posed anchors (Stage 7.5) ───

  it('carries the anchors into the solved pose, points moved and axes only rotated', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1', {
      anchors: {
        a1: { kind: 'plane', point: [1, 0, 0], axis: [1, 0, 0], geom_hash: 'g1', created_by: 'feat1' },
      },
    }))

    // 90° about +Z, then lifted 3 in z. No mates, so the placed transform is
    // echoed straight back and the anchor must land under exactly it.
    const s = Math.SQRT1_2
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: { tx: 0, ty: 0, tz: 3, qx: 0, qy: 0, qz: s, qw: s } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1' }, [], relay, makeEchoSolver())

    const posed = result.anchors['p1'].a1
    expect(posed.point[0]).toBeCloseTo(0)
    expect(posed.point[1]).toBeCloseTo(1)
    expect(posed.point[2]).toBeCloseTo(3)  // the translation
    expect(posed.axis[0]).toBeCloseTo(0)
    expect(posed.axis[1]).toBeCloseTo(1)
    expect(posed.axis[2]).toBeCloseTo(0)  // a direction takes no translation
    expect(posed.kind).toBe('plane')
    // The roll-capture frame: canonicalPerp of the LOCAL axis (x -> +z), then
    // rotated with the part. 90° about +Z leaves +z where it was.
    expect(posed.x_axis![0]).toBeCloseTo(0)
    expect(posed.x_axis![1]).toBeCloseTo(0)
    expect(posed.x_axis![2]).toBeCloseTo(1)
  })

  it('does not ship the match descriptors: they are migration inputs, not render data', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))

    const parts = [{ handle: 'p1', doc_id: 'doc-a', transform: identityTransform() }]
    const result = await solveAssembly(parts, { 'doc-a': '1' }, [], relay, makeEchoSolver())

    expect(Object.keys(result.anchors['p1'].a1).sort()).toEqual(['axis', 'kind', 'point', 'x_axis'])
  })

  it('gives two instances of one part independently posed anchors', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', '1'))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', transform: translationTransform(100, 0, 0) },
      { handle: 'p2', doc_id: 'doc-a', transform: translationTransform(-100, 0, 0) },
    ]
    const result = await solveAssembly(parts, { 'doc-a': '1' }, [], relay, makeEchoSolver())

    expect(result.anchors['p1'].a1.point[0]).toBeCloseTo(100)
    expect(result.anchors['p2'].a1.point[0]).toBeCloseTo(-100)
  })
})
