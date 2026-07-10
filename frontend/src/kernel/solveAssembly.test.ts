/**
 * Unit tests for solveAssembly orchestration. Tests cover:
 * - MateInput encode/decode round-trip
 * - Bundle cache hit/miss branches
 * - Anchor resolution + stale detection
 * - Mate solve via injected solver function
 * - Transform application to body meshes
 *
 * All tests use a fake relay (no real OCC worker) and a fake solver function
 * (no real WASM), so they run purely on the main thread.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { solveAssembly, encodeMateInput, decodeMateOutput, assemblyAnchors } from './solveAssembly'
import { bundleCachePut, bundleCacheGet, resetBundleDbConnection } from './bundleCache'

// Wraps the real bundleCacheGet in a spy (delegating to the actual
// implementation) so the Stage F test below can assert call count without
// disturbing the fake-indexeddb-backed behaviour every other test relies on.
vi.mock('./bundleCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bundleCache')>()
  return { ...actual, bundleCacheGet: vi.fn(actual.bundleCacheGet) }
})
import { ASSEMBLY_HANDLE, ASSEMBLY_TOP_ID } from '../utils/assemblyBuiltins'
import { sampleEdgeCurve } from '../utils/edgeSampling'
import { BUNDLE_SCHEMA, type AnchorKind, type PartBundle } from './partBundle'
import type { Transform3D } from '../types/cad'
import type { RelayService } from './worker/anchorSolverWorker'

// The encode/decode functions are not exported, but solveAssembly calls them
// internally. We test the wire format indirectly through solveAssembly.

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
}

function identityTransform(): Transform3D {
  return { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
}

function translationTransform(tx: number, ty: number, tz: number): Transform3D {
  return { tx, ty, tz, qx: 0, qy: 0, qz: 0, qw: 1 }
}

function makeBundle(doc_id: string, doc_rev: number, overrides?: Partial<PartBundle>): PartBundle {
  return {
    doc_id,
    doc_rev,
    schema: BUNDLE_SCHEMA,
    bodies: [
      {
        mesh: {
          vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0]),
          indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
          faceIdsPerTriangle: new Uint32Array([0, 0]),
        },
        edges: [],
      },
    ],
    anchors: {
      a1: {
        kind: 'point',
        point: [0, 0, 0],
        axis: [0, 0, 1],
        geom_hash: '@gdf|0.000|0.000|0.000|0.000|0.000|1.000',
        created_by: 'feat1',
      },
      a2: {
        kind: 'point',
        point: [10, 0, 0],
        axis: [0, 0, 1],
        geom_hash: '@gdf|10.000|0.000|0.000|0.000|0.000|1.000',
        created_by: 'feat1',
      },
    },
    ...overrides,
  }
}

function makeRelay(): { relay: RelayService; partDocs: Map<string, Record<string, unknown>> } {
  const partDocs = new Map<string, Record<string, unknown>>()
  return {
    relay: {
      requestPartDoc: vi.fn().mockImplementation(async (doc_id: string) => {
        const doc = partDocs.get(doc_id)
        if (!doc) throw new Error(`part doc not found: ${doc_id}`)
        return doc
      }),
      requestBuildBundle: vi.fn().mockImplementation(async (doc_id: string, doc_rev: number, _spec: Record<string, unknown>) => {
        return makeBundle(doc_id, doc_rev)
      }),
    },
    partDocs,
  }
}

/** Build a no-op solver that echoes the input transforms unchanged. */
function makeEchoSolver(): (input: Uint8Array) => Uint8Array {
  return (input: Uint8Array): Uint8Array => {
    // Decode the input to get the initial params.
    // The input header is: magic(4) + n_bodies(4) + n_params(4) + n_mates(4) + n_fixed(4)
    // Then n_bodies * 4 bytes of body indices, then paramsInitial.
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const nBodies = view.getUint32(4, true)
    const nParams = nBodies * 7
    const paramsOffset = 20 + nBodies * 4
    const params: number[] = []
    for (let i = 0; i < nParams; i++) {
      params.push(view.getFloat32(paramsOffset + i * 4, true))
    }

    // Build output: magic(4) + n_params(4) + status(1) + params(nParams*4) + diagnostics(28)
    const outSize = 4 + 4 + 1 + nParams * 4 + 28
    const outBuf = new ArrayBuffer(outSize)
    const out = new DataView(outBuf)
    let pos = 0
    out.setUint32(pos, 0x5231544D, true); pos += 4  // MATE_MAGIC_OUT
    out.setUint32(pos, nParams, true); pos += 4
    out.setUint8(pos, 0); pos += 1  // fully constrained
    for (let i = 0; i < nParams; i++) {
      out.setFloat32(pos, params[i], true); pos += 4
    }
    out.setFloat64(pos, 0.0, true); pos += 8  // residual_norm
    out.setUint32(pos, 13, true); pos += 4  // rank
    out.setUint32(pos, 1, true); pos += 4  // dof
    out.setUint32(pos, 1, true); pos += 4  // iters
    out.setFloat64(pos, 0.001, true); pos += 8  // ms
    return new Uint8Array(outBuf)
  }
}

/** Build a solver that translates body1 by (dx,0,0). */
function makeTranslateSolver(dx: number): (input: Uint8Array) => Uint8Array {
  return (input: Uint8Array): Uint8Array => {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const nBodies = view.getUint32(4, true)
    const nParams = nBodies * 7
    const paramsOffset = 20 + nBodies * 4
    const params: number[] = []
    for (let i = 0; i < nParams; i++) {
      params.push(view.getFloat32(paramsOffset + i * 4, true))
    }
    // Translate the second body (indices 7-13)
    if (nBodies >= 2) {
      params[7] += dx
    }

    const outSize = 4 + 4 + 1 + nParams * 4 + 28
    const outBuf = new ArrayBuffer(outSize)
    const out = new DataView(outBuf)
    let pos = 0
    out.setUint32(pos, 0x5231544D, true); pos += 4
    out.setUint32(pos, nParams, true); pos += 4
    out.setUint8(pos, 0); pos += 1
    for (let i = 0; i < nParams; i++) {
      out.setFloat32(pos, params[i], true); pos += 4
    }
    out.setFloat64(pos, 0.0, true); pos += 8
    out.setUint32(pos, 13, true); pos += 4
    out.setUint32(pos, 1, true); pos += 4
    out.setUint32(pos, 1, true); pos += 4
    out.setFloat64(pos, 0.001, true); pos += 8
    return new Uint8Array(outBuf)
  }
}

/**
 * An echo solver that scales `bodyIndex`'s whole quaternion by `scale` before
 * returning it -- standing in for the soft unit-norm residual only holding
 * |q| to within LM's tolerance, not exactly (Stage C).
 */
function makeScaledQwSolver(bodyIndex: number, scale: number): (input: Uint8Array) => Uint8Array {
  return (input: Uint8Array): Uint8Array => {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const nBodies = view.getUint32(4, true)
    const nParams = nBodies * 7
    const paramsOffset = 20 + nBodies * 4
    const params: number[] = []
    for (let i = 0; i < nParams; i++) {
      params.push(view.getFloat32(paramsOffset + i * 4, true))
    }
    for (let c = 3; c < 7; c++) params[bodyIndex * 7 + c] *= scale

    const outSize = 4 + 4 + 1 + nParams * 4 + 28
    const outBuf = new ArrayBuffer(outSize)
    const out = new DataView(outBuf)
    let pos = 0
    out.setUint32(pos, 0x5231544D, true); pos += 4
    out.setUint32(pos, nParams, true); pos += 4
    out.setUint8(pos, 0); pos += 1
    for (let i = 0; i < nParams; i++) {
      out.setFloat32(pos, params[i], true); pos += 4
    }
    out.setFloat64(pos, 0.0, true); pos += 8
    out.setUint32(pos, 13, true); pos += 4
    out.setUint32(pos, 1, true); pos += 4
    out.setUint32(pos, 1, true); pos += 4
    out.setFloat64(pos, 0.001, true); pos += 8
    return new Uint8Array(outBuf)
  }
}

interface DecodedMateRecord {
  kindCode: number
  bodyA: number
  bodyB: number
  anchorKindA: number
  anchorKindB: number
  pointA: [number, number, number]
  axisA: [number, number, number]
  pointB: [number, number, number]
  axisB: [number, number, number]
  angle: number
}

interface DecodedInput {
  nBodies: number
  fixedMask: number[]
  mates: DecodedMateRecord[]
}

/** Decode a mate-solver input buffer far enough to inspect bodies + mate records. */
function decodeInput(input: Uint8Array): DecodedInput {
  const v = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const nBodies = v.getUint32(4, true)
  const nParams = v.getUint32(8, true)
  const nMates = v.getUint32(12, true)
  let pos = 20 + nBodies * 4 + nParams * 4
  const maskLen = Math.ceil(nBodies / 8)
  const fixedMask: number[] = []
  for (let i = 0; i < maskLen; i++) fixedMask.push(v.getUint8(pos + i))
  pos += maskLen
  const readVec = (): [number, number, number] => {
    const out: [number, number, number] = [
      v.getFloat32(pos, true), v.getFloat32(pos + 4, true), v.getFloat32(pos + 8, true),
    ]
    pos += 12
    return out
  }
  const mates: DecodedMateRecord[] = []
  for (let i = 0; i < nMates; i++) {
    const kindCode = v.getUint8(pos); pos += 1
    const bodyA = v.getUint32(pos, true); pos += 4
    const bodyB = v.getUint32(pos, true); pos += 4
    const anchorKindA = v.getUint8(pos); pos += 1
    const anchorKindB = v.getUint8(pos); pos += 1
    const pointA = readVec()
    const axisA = readVec()
    const pointB = readVec()
    const axisB = readVec()
    pos += 1 + 4 + 4 + 4  // flags + offset + ratio + radius
    const angle = v.getFloat32(pos, true); pos += 4
    mates.push({ kindCode, bodyA, bodyB, anchorKindA, anchorKindB, pointA, axisA, pointB, axisB, angle })
  }
  return { nBodies, fixedMask, mates }
}

/** An echo solver that also captures the decoded input for inspection. */
function makeCaptureSolver(): { solver: (input: Uint8Array) => Uint8Array; captured: { input?: DecodedInput } } {
  const echo = makeEchoSolver()
  const captured: { input?: DecodedInput } = {}
  return {
    solver: (input: Uint8Array) => {
      captured.input = decodeInput(input)
      return echo(input)
    },
    captured,
  }
}

beforeEach(() => {
  freshDb()
})

describe('solveAssembly', () => {
  // ── mateless / cache-hit branch ──────────────────────────────────────

  it('echoes transforms for a mateless doc with cache hit', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    const bundle = makeBundle('doc-a', 3)
    await bundleCachePut(bundle)

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 3, transform: translationTransform(1, 2, 3) },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 3 }, [], relay, makeEchoSolver())

    expect(result.transforms).toEqual({ p1: translationTransform(1, 2, 3) })
    expect(result.bodies).toHaveProperty('p1')
    expect(result.bodies['p1']).toHaveLength(1)
    expect(result.mateResults).toEqual({})
    // No relay calls since cache hit
    expect(vi.mocked(relay.requestPartDoc)).not.toHaveBeenCalled()
  })

  it('calls relay on bundle cache miss', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 3, transform: identityTransform() },
    ]
    await solveAssembly(parts, { 'doc-a': 3 }, [], relay, makeEchoSolver())

    expect(relay.requestPartDoc).toHaveBeenCalledWith('doc-a')
    expect(relay.requestBuildBundle).toHaveBeenCalledWith('doc-a', 3, { kind: 'part', features: [] })
  })

  it('uses bundle cache on second solve (no relay calls)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 3, transform: identityTransform() },
    ]

    // First solve: cache miss, relay called
    await solveAssembly(parts, { 'doc-a': 3 }, [], relay, makeEchoSolver())
    expect(relay.requestPartDoc).toHaveBeenCalledTimes(1)

    const callCount = vi.mocked(relay.requestPartDoc).mock.calls.length

    // Second solve: cache hit, no relay
    await solveAssembly(parts, { 'doc-a': 3 }, [], relay, makeEchoSolver())
    expect(vi.mocked(relay.requestPartDoc).mock.calls.length).toBe(callCount)
  })

  it('bumps rev triggers single bundle rebuild per part', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })

    // Pre-cache doc-a at rev 3
    await bundleCachePut(makeBundle('doc-a', 3))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 3, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: identityTransform() },
    ]
    const revs = { 'doc-a': 4, 'doc-b': 1 }  // doc-a has updated

    await solveAssembly(parts, revs, [], relay, makeEchoSolver())

    // doc-a: cache miss at rev 4, relay called for part doc + build bundle
    // doc-b: cache miss at rev 1, relay called too
    expect(relay.requestPartDoc).toHaveBeenCalledWith('doc-a')
    expect(relay.requestPartDoc).toHaveBeenCalledWith('doc-b')
  })

  it('a big rev jump with only an old rev cached issues exactly one bundleCacheGet for the migration lookup', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', 3))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 3, transform: identityTransform() },
    ]

    vi.mocked(bundleCacheGet).mockClear()

    await solveAssembly(parts, { 'doc-a': 800 }, [], relay, makeEchoSolver())

    // One get for the top-of-loop cache-hit check at rev 800 (a miss), then
    // exactly one more for the Stage F `latestRev` migration lookup (rev 3) --
    // not the old downward scan that would have issued 799 separate gets.
    expect(vi.mocked(bundleCacheGet).mock.calls).toEqual([
      ['doc-a', 800],
      ['doc-a', 3],
    ])
  })

  // ── mate solve branch ────────────────────────────────────────────────

  it('solves a spherical mate between two parts', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })

    // Pre-cache bundles
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(0, 0, 0) },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'spherical',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: 'p2', anchor: 'a1' },
      },
    ]
    const revs = { 'doc-a': 1, 'doc-b': 1 }

    const result = await solveAssembly(parts, revs, mates, relay, makeEchoSolver())

    expect(result.transforms).toHaveProperty('p1')
    expect(result.transforms).toHaveProperty('p2')
    expect(result.bodies).toHaveProperty('p1')
    expect(result.bodies).toHaveProperty('p2')
    expect(result.mateResults).toHaveProperty('m1')
    expect(result.mateResults['m1'].stale).toBe(false)
    // No relay calls (both cache hits)
    expect(relay.requestPartDoc).not.toHaveBeenCalled()
  })

  it('encodes a fixed mate angle authored in degrees as radians on the wire', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(0, 0, 0) },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
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
    await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    expect(captured.input!.mates[0].angle).toBeCloseTo(Math.PI / 2)
  })

  it('apply transforms to vertices', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, makeTranslateSolver(10))

    // The solver we used is 'echo' — it returns the input transforms
    // which is identity. So vertices should be at identity too.
    const body = result.bodies['p1'][0]
    // With identity transform (echo solver), vertices unchanged
    expect(body.vertices[0]).toBeCloseTo(0)
    expect(body.vertices[3]).toBeCloseTo(10)
  })

  it('normalizes a solved quaternion that is unit only to solver tolerance (qw = 1.02), leaving vertex distances from the origin unchanged', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1, {
      bodies: [{
        mesh: {
          vertices: new Float32Array([3, 4, 0, 0, 0, 5]),  // distances 5 and 5 from origin
          indices: new Uint32Array([]),
          faceIdsPerTriangle: new Uint32Array([]),
        },
        edges: [],
      }],
    }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform(), fixed: true },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: identityTransform() },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    // Body index 1 is p2 (p1 is index 0).
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, makeScaledQwSolver(1, 1.02))

    const t = result.transforms['p2']
    expect(Math.hypot(t.qx, t.qy, t.qz, t.qw)).toBeCloseTo(1, 6)

    const verts = result.bodies['p2'][0].vertices
    const dist0 = Math.hypot(verts[0], verts[1], verts[2])
    const dist1 = Math.hypot(verts[3], verts[4], verts[5])
    expect(dist0).toBeCloseTo(5, 5)
    expect(dist1).toBeCloseTo(5, 5)
  })

  // ── edge curves ──────────────────────────────────────────────────────

  it('carries the bundle edge curves into the payload in the solved pose', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    // A line along +X and a circle in the z=0 plane, both at the part origin.
    await bundleCachePut(makeBundle('doc-a', 1, {
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
      }],
    }))

    // 90° about +Z, then lifted 3 in z. No mates, so the placed transform is
    // echoed straight back and the edges must land under exactly it.
    const s = Math.SQRT1_2
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: { tx: 0, ty: 0, tz: 3, qx: 0, qy: 0, qz: s, qw: s } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, makeEchoSolver())

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

    // A rigid motion leaves radius and sweep alone — that is what keeps the
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
    await bundleCachePut(makeBundle('doc-a', 1, {
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
      }],
    }))

    const s = Math.SQRT1_2  // 90° about +Z, lifted 3 in z
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: { tx: 0, ty: 0, tz: 3, qx: 0, qy: 0, qz: s, qw: s } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, makeEchoSolver())
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
    await bundleCachePut(makeBundle('doc-a', 1, {
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
      }],
    }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(100, 0, 0) },
      { handle: 'p2', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(-100, 0, 0) },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, makeEchoSolver())

    // One bundle, two poses: the shared source must not leak one part's pose
    // into the other.
    expect(result.bodies['p1'][0].edges[0].endpoints[0][0]).toBeCloseTo(100)
    expect(result.bodies['p2'][0].edges[0].endpoints[0][0]).toBeCloseTo(-100)
  })

  // ── posed anchors (Stage 7.5) ────────────────────────────────────────

  it('carries the anchors into the solved pose, points moved and axes only rotated', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1, {
      anchors: {
        a1: { kind: 'plane', point: [1, 0, 0], axis: [1, 0, 0], geom_hash: 'g1', created_by: 'feat1' },
      },
    }))

    // 90° about +Z, then lifted 3 in z. No mates, so the placed transform is
    // echoed straight back and the anchor must land under exactly it.
    const s = Math.SQRT1_2
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: { tx: 0, ty: 0, tz: 3, qx: 0, qy: 0, qz: s, qw: s } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, makeEchoSolver())

    const posed = result.anchors['p1'].a1
    expect(posed.point[0]).toBeCloseTo(0)
    expect(posed.point[1]).toBeCloseTo(1)
    expect(posed.point[2]).toBeCloseTo(3)  // the translation
    expect(posed.axis[0]).toBeCloseTo(0)
    expect(posed.axis[1]).toBeCloseTo(1)
    expect(posed.axis[2]).toBeCloseTo(0)   // a direction takes no translation
    expect(posed.kind).toBe('plane')
  })

  it('does not ship the match descriptors: they are migration inputs, not render data', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [{ handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() }]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, makeEchoSolver())

    expect(Object.keys(result.anchors['p1'].a1).sort()).toEqual(['axis', 'kind', 'point'])
  })

  it('gives two instances of one part independently posed anchors', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(100, 0, 0) },
      { handle: 'p2', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(-100, 0, 0) },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, makeEchoSolver())

    expect(result.anchors['p1'].a1.point[0]).toBeCloseTo(100)
    expect(result.anchors['p2'].a1.point[0]).toBeCloseTo(-100)
  })

  // ── stale ref detection ──────────────────────────────────────────────

  it('flags a mate as stale when anchor is missing from bundle', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })

    const b2 = makeBundle('doc-b', 1)
    // Remove 'a1' from doc-b's anchors
    delete b2.anchors.a1
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(b2)

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'spherical',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: 'p2', anchor: 'a1' },  // missing from bundle
      },
    ]

    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, makeEchoSolver())

    expect(result.mateResults['m1'].stale).toBe(true)
    expect(result.mateResults['m1'].staleRefs).toContain('ref_b')
  })

  it('flags a mate as stale when part is missing', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'spherical',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: 'p2', anchor: 'a1' },  // p2 not in parts array
      },
    ]

    const result = await solveAssembly(parts, { 'doc-a': 1 }, mates, relay, makeEchoSolver())

    expect(result.mateResults['m1'].stale).toBe(true)
    expect(result.mateResults['m1'].staleRefs).toContain('ref_b')
  })

  // ── error handling ───────────────────────────────────────────────────

  it('returns seed transforms when solver is null', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(1, 2, 3) },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, null)

    expect(result.transforms['p1']).toEqual(translationTransform(1, 2, 3))
  })

  it('handles empty parts array', async () => {
    const { relay } = makeRelay()
    const result = await solveAssembly([], {}, [], relay, makeEchoSolver())

    expect(result.transforms).toEqual({})
    expect(result.bodies).toEqual({})
    expect(result.mateResults).toEqual({})
  })

  // ── assembly built-ins as ground (Stage 6c) ──────────────────────────

  it('resolves a fixed mate from a part to the assembly Top plane through assemblyAnchors', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(0, 5, 0) },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'fixed',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_TOP_ID },
      },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': 1 }, mates, relay, solver)

    // The mate resolved (not stale) and the part got a solved transform.
    expect(result.mateResults['m1'].stale).toBe(false)
    expect(result.transforms).toHaveProperty('p1')
    // The assembly frame is synthetic: it never appears as an output transform.
    expect(result.transforms).not.toHaveProperty(ASSEMBLY_HANDLE)

    // The solver saw the part body (0) + a pinned assembly frame body (1).
    expect(captured.input!.nBodies).toBe(2)
    expect(captured.input!.fixedMask[0] & 0b10).toBe(0b10)  // body 1 grounded

    // ref_b carried the Top-plane anchor geometry from assemblyAnchors.
    const rec = captured.input!.mates[0]
    expect(rec.bodyA).toBe(0)
    expect(rec.bodyB).toBe(1)
    const top = assemblyAnchors[ASSEMBLY_TOP_ID]
    expect(rec.pointB).toEqual(top.point)
    expect(rec.axisB).toEqual(top.axis)
  })

  it('flags a mate stale when the assembly anchor id is unknown', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'fixed',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: ASSEMBLY_HANDLE, anchor: 'NoSuchPlane' },
      },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, mates, relay, makeEchoSolver())

    expect(result.mateResults['m1'].stale).toBe(true)
    expect(result.mateResults['m1'].staleRefs).toContain('ref_b')
  })

  it('flags a mate stale with an error, not fixed, for an unknown mate kind', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'bad', kind: 'not_a_real_kind', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
      { id: 'ok', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a2' }, ref_b: { part: 'p2', anchor: 'a2' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    expect(result.mateResults['bad'].stale).toBe(true)
    expect(result.mateResults['bad'].error).toContain('not_a_real_kind')
    expect(result.mateResults['ok'].stale).toBe(false)
    // The unknown mate contributes zero bytes to the encoded buffer -- not
    // coerced into a `fixed` (kindCode 0) record.
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('flags a mate stale with an error for an unknown anchor kind', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1, {
      // `as AnchorKind`: simulates a bundle built by a newer app version that
      // added a kind this build's union doesn't know about yet.
      anchors: {
        a1: { kind: 'not_a_real_anchor_kind' as AnchorKind, point: [0, 0, 0], axis: [0, 0, 1], geom_hash: 'g', created_by: 'f' },
        a2: { kind: 'point', point: [1, 0, 0], axis: [0, 0, 1], geom_hash: 'g2', created_by: 'f' },
      },
    }))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'bad', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
      { id: 'ok', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a2' }, ref_b: { part: 'p2', anchor: 'a2' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    expect(result.mateResults['bad'].stale).toBe(true)
    expect(result.mateResults['bad'].error).toContain('not_a_real_anchor_kind')
    expect(result.mateResults['ok'].stale).toBe(false)
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('flags a mate stale with the two-parts message when both refs name the same part, and other mates still solve', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'self', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p1', anchor: 'a2' } },
      { id: 'ok', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    expect(result.mateResults['self'].stale).toBe(true)
    expect(result.mateResults['self'].error).toBe('a mate needs two different parts')
    expect(result.mateResults['ok'].stale).toBe(false)
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('sets solveError and falls back to seed transforms when the solve output has the wrong param count', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    // A solver that returns an output for only one body when two were sent.
    const shortSolver = (): Uint8Array => {
      const w = new DataView(new ArrayBuffer(20 + 7 * 4 + 24))
      w.setUint32(0, 0x5231_544D, true)  // MATE_MAGIC_OUT
      w.setUint32(4, 7, true)  // nParams = 7, but the caller expects 14
      w.setUint8(8, 0)
      return new Uint8Array(w.buffer)
    }
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, shortSolver)

    expect(result.solveError).toContain('params')
    expect(result.mateResults['m1'].error).toContain('params')
    expect(result.transforms['p2']).toEqual(translationTransform(5, 0, 0))
  })

  // ── grounded instances (Stage 6d) ────────────────────────────────────

  it('pins a fixed part instance in the LM state and leaves free parts unpinned', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform(), fixed: true },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    expect(captured.input!.nBodies).toBe(2)
    expect(captured.input!.fixedMask[0] & 0b01).toBe(0b01)  // body 0 grounded
    expect(captured.input!.fixedMask[0] & 0b10).toBe(0)     // body 1 free
  })

  it('pins the grounded part alongside the assembly frame when a mate uses both', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform(), fixed: true },
    ]
    const mates = [
      {
        id: 'm1',
        kind: 'fixed',
        ref_a: { part: 'p1', anchor: 'a1' },
        ref_b: { part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_TOP_ID },
      },
    ]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': 1 }, mates, relay, solver)

    expect(captured.input!.nBodies).toBe(2)
    expect(captured.input!.fixedMask[0] & 0b11).toBe(0b11)  // part + frame both pinned
  })

  it('does not allocate an assembly frame body when no mate references it', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    // Only the two part bodies; nothing pinned.
    expect(captured.input!.nBodies).toBe(2)
    expect(captured.input!.fixedMask[0]).toBe(0)
  })
})

describe('mate wire format', () => {
  it('encode/decode round-trips params', () => {
    // Test the wire format indirectly: encode with known input,
    // decode the output from a fake solver that echoes params.
    const params = new Float32Array(14)
    for (let i = 0; i < 14; i++) params[i] = i * 0.1
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(2, params, fixedMask, [])
    const solver = makeEchoSolver()
    const outputBytes = solver(encoded)
    const decoded = decodeMateOutput(outputBytes, 14)

    expect(decoded.paramsSolved).toHaveLength(14)
    for (let i = 0; i < 14; i++) {
      expect(decoded.paramsSolved[i]).toBeCloseTo(params[i])
    }
  })

  it('decode detects bad magic', () => {
    const bad = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0])
    expect(() => decodeMateOutput(bad, 0)).toThrow('bad mate output magic')
  })

  it('decode detects a params-count mismatch (short buffer, e.g. wrong bodyCount)', () => {
    const params = new Float32Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [])
    const outputBytes = makeEchoSolver()(encoded)
    expect(() => decodeMateOutput(outputBytes, 14)).toThrow(/params/)
  })

  it('byte sizes align with Rust format', () => {
    // One empty body, no mates: header 20 + bodies 4 + params 28 + mask 1 = 53 bytes
    const params = new Float32Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [])
    expect(encoded.length).toBe(53)

    // One mate record adds exactly 76 bytes
    const encodedWithMate = encodeMateInput(1, params, fixedMask, [{
      kindCode: 1,
      bodyA: 0, bodyB: 0,
      anchorKindA: 6, anchorKindB: 6,
      pointA: [0, 0, 0], axisA: [0, 0, 1],
      pointB: [1, 0, 0], axisB: [0, 0, 1],
      flip: false, offset: 0, ratio: 1, radius: 0, angle: 0,
    }])
    expect(encodedWithMate.length).toBe(53 + 76)
  })

  it('places angle at the documented offset in the mate record', () => {
    // Record layout after the 53-byte header+body+params+mask prefix (1 body):
    // kind(1) + bodyA(4) + bodyB(4) + anchorKinds(2) + pointA(12) + axisA(12)
    // + pointB(12) + axisB(12) + flags(1) + offset(4) + ratio(4) + radius(4) = 72,
    // then angle is the trailing f32 at byte 72 of the record.
    const params = new Float32Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [{
      kindCode: 0,
      bodyA: 0, bodyB: 0,
      anchorKindA: 0, anchorKindB: 0,
      pointA: [0, 0, 0], axisA: [0, 0, 1],
      pointB: [0, 0, 0], axisB: [0, 0, 1],
      flip: false, offset: 0, ratio: 1, radius: 0, angle: Math.PI / 4,
    }])
    const recordStart = 53
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getFloat32(recordStart + 72, true)).toBeCloseTo(Math.PI / 4)
  })
})
