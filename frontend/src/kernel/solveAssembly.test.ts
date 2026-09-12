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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { solveAssembly, encodeMateInput, decodeMateOutput, assemblyAnchors, type MateSpec } from './solveAssembly'
import { bundleCachePut, bundleCacheGet, bundleCacheGetStale, bundleCacheLatestRev, resetBundleDbConnection } from './bundleCache'

// Wraps the real bundleCache functions in spies (delegating to the actual
// implementations) so tests can assert call counts or force rejections without
// disturbing the fake-indexeddb-backed behaviour every other test relies on.
vi.mock('./bundleCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bundleCache')>()
  return {
    ...actual,
    bundleCacheGet: vi.fn(actual.bundleCacheGet),
    bundleCacheGetStale: vi.fn(actual.bundleCacheGetStale),
    bundleCacheLatestRev: vi.fn(actual.bundleCacheLatestRev),
    bundleCachePut: vi.fn(actual.bundleCachePut),
  }
})
import { ASSEMBLY_HANDLE, ASSEMBLY_ORIGIN_ID, ASSEMBLY_TOP_ID } from '../utils/assemblyBuiltins'
import { sampleEdgeCurve } from '../utils/edgeSampling'
import { mateFailure, partFailure } from '../utils/core/assemblyStatus'
import { buildEntityMateRefs } from '../utils/assemblyBodies'
import { assemblyEntityKey } from '../utils/anchorCandidates'
import { anchorIdFor, BUNDLE_SCHEMA, type Anchor, type AnchorKind, type PartBundle } from './partBundle'
import type { Transform3D, MateAnchorDescriptor } from '../types/cad'
import type { RelayService } from './worker/anchorSolverWorker'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetBundleDbConnection()
}

/**
 * The shared mate-wire fixture (tests/fixtures/mate_wire.txt), also read by the
 * Rust wire tests. Magic and stride drift between the two languages fails here
 * instead of silently mis-solving.
 */
function readMateWireFixture(): Record<string, number> {
  // Derived from this module's own location, the way loadPkgNode.ts finds its
  // build artifacts, not from the process cwd. A `new URL(relative,
  // import.meta.url)` here is rewritten by Vite's asset handling and does not
  // survive as a file URL for a path outside the frontend root.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const text = readFileSync(path.resolve(here, '../../../tests/fixtures/mate_wire.txt'), 'utf8')
  const out: Record<string, number> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    out[key] = value.startsWith('0x') ? parseInt(value, 16) : Number(value)
  }
  return out
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
        entityAnchors: { faces: [], edges: [], vertices: [] },
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

// A bundle whose anchor ids are the deterministic shortHash(geom_hash + kind),
// standing in for a bundle built by the post-deterministic-id production code.
function makeDeterministicBundle(doc_id: string, doc_rev: number): PartBundle {
  const bundle = makeBundle(doc_id, doc_rev)
  const anchors: Record<string, Anchor> = {}
  for (const a of Object.values(bundle.anchors)) {
    anchors[anchorIdFor(a.geom_hash, a.kind)] = a
  }
  return { ...bundle, anchors }
}

// A bundle whose a1 carries a real axis (a plane), for the wire tests that
// exercise an axis-reading mate. `makeBundle`'s a1 is a vertex, whose axis is
// the placeholder [0, 0, 1] the solve now refuses for an axis reader.
function makeAxialBundle(doc_id: string, doc_rev: number): PartBundle {
  return makeBundle(doc_id, doc_rev, {
    anchors: {
      a1: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|a1', created_by: 'feat1' },
      a2: { kind: 'point', point: [10, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|a2', created_by: 'feat1' },
    },
  })
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
    const outSize = 4 + 4 + 1 + nParams * 4 + 4 + 28  // +4 for the n_mates header
    const outBuf = new ArrayBuffer(outSize)
    const out = new DataView(outBuf)
    let pos = 0
    out.setUint32(pos, 0x3252544D, true); pos += 4  // MATE_MAGIC_OUT
    out.setUint32(pos, nParams, true); pos += 4
    out.setUint8(pos, 0); pos += 1  // fully constrained
    for (let i = 0; i < nParams; i++) {
      out.setFloat32(pos, params[i], true); pos += 4
    }
    out.setUint32(pos, 0, true); pos += 4  // n_mates
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

    const outSize = 4 + 4 + 1 + nParams * 4 + 4 + 28  // +4 for the n_mates header
    const outBuf = new ArrayBuffer(outSize)
    const out = new DataView(outBuf)
    let pos = 0
    out.setUint32(pos, 0x3252544D, true); pos += 4
    out.setUint32(pos, nParams, true); pos += 4
    out.setUint8(pos, 0); pos += 1
    for (let i = 0; i < nParams; i++) {
      out.setFloat32(pos, params[i], true); pos += 4
    }
    out.setUint32(pos, 0, true); pos += 4  // n_mates
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

    const outSize = 4 + 4 + 1 + nParams * 4 + 4 + 28  // +4 for the n_mates header
    const outBuf = new ArrayBuffer(outSize)
    const out = new DataView(outBuf)
    let pos = 0
    out.setUint32(pos, 0x3252544D, true); pos += 4
    out.setUint32(pos, nParams, true); pos += 4
    out.setUint8(pos, 0); pos += 1
    for (let i = 0; i < nParams; i++) {
      out.setFloat32(pos, params[i], true); pos += 4
    }
    out.setUint32(pos, 0, true); pos += 4  // n_mates
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
  offset: [number, number, number]
  angle: number
  weight: number
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
    pos += 1  // flags
    const offset = readVec()
    pos += 4 + 4  // ratio + radius
    const angle = v.getFloat32(pos, true); pos += 4
    pos += 24  // perp_a (3 f32) + perp_b (3 f32)
    const weight = v.getFloat32(pos, true); pos += 4
    mates.push({ kindCode, bodyA, bodyB, anchorKindA, anchorKindB, pointA, axisA, pointB, axisB, offset, angle, weight })
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
  // ─── mateless / cache-hit branch ───

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
    expect(result.status.mates).toEqual({})
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

  it('a big rev jump with only an old rev cached issues exactly one get for the migration lookup', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', 3))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 3, transform: identityTransform() },
    ]

    vi.mocked(bundleCacheGet).mockClear()
    vi.mocked(bundleCacheGetStale).mockClear()

    await solveAssembly(parts, { 'doc-a': 800 }, [], relay, makeEchoSolver())

    // One get for the top-of-loop cache-hit check at rev 800 (a miss), then
    // exactly one more for the latest-rev migration lookup (rev 3), read raw
    // so a schema/fingerprint-stale record can still serve the remap chain --
    // not the old downward scan that would have issued 799 separate gets.
    expect(vi.mocked(bundleCacheGet).mock.calls).toEqual([
      ['doc-a', 800],
    ])
    expect(vi.mocked(bundleCacheGetStale).mock.calls).toEqual([
      ['doc-a', 3],
    ])
  })

  it('rebuilds a cached bundle whose bodies lack entityAnchors (pre-Stage-7 cache)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    // Cache a bundle deliberately missing entityAnchors on every body.
    const stale = makeBundle('doc-a', 3, {
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
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 3, transform: identityTransform() },
    ]
    await solveAssembly(parts, { 'doc-a': 3 }, [], relay, makeEchoSolver())

    // The stale cache should force a rebuild: relay is called.
    expect(relay.requestPartDoc).toHaveBeenCalledWith('doc-a')
    expect(relay.requestBuildBundle).toHaveBeenCalledWith('doc-a', 3, expect.any(Object))
  })

  // ─── mate solve branch ───

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
    expect(result.status.mates).toHaveProperty('m1')
    expect(result.status.mates['m1'].stale).toBe(false)
    // No relay calls (both cache hits)
    expect(relay.requestPartDoc).not.toHaveBeenCalled()
  })

  it('encodes a fixed mate angle authored in degrees as radians on the wire', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeAxialBundle('doc-a', 1))
    await bundleCachePut(makeAxialBundle('doc-b', 1))

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

  // The tolerant dual-read at the wire. A legacy document authored `offset: 7`
  // as a distance along A's anchor axis; the record now carries a vector, and
  // the scalar has to arrive as exactly that same displacement or every saved
  // assembly shifts. There is no document migration to lean on.
  it('expands a legacy scalar offset along the A anchor axis on the wire', async () => {
    const { relay } = makeRelay()
    await bundleCachePut(makeAxialBundle('doc-a', 1))
    await bundleCachePut(makeAxialBundle('doc-b', 1))
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(0, 0, 0) },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    // a1's axis is (0, 0, 1), so a scalar 7 is the vector (0, 0, 7).
    const mates = [{
      id: 'm1', kind: 'fixed',
      ref_a: { part: 'p1', anchor: 'a1' },
      ref_b: { part: 'p2', anchor: 'a1' },
      offset: 7,
    }]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    expect(captured.input!.mates[0].offset[0]).toBeCloseTo(0)
    expect(captured.input!.mates[0].offset[1]).toBeCloseTo(0)
    expect(captured.input!.mates[0].offset[2]).toBeCloseTo(7)
  })

  it('encodes a vector offset componentwise', async () => {
    const { relay } = makeRelay()
    await bundleCachePut(makeAxialBundle('doc-a', 1))
    await bundleCachePut(makeAxialBundle('doc-b', 1))
    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(0, 0, 0) },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [{
      id: 'm1', kind: 'fixed',
      ref_a: { part: 'p1', anchor: 'a1' },
      ref_b: { part: 'p2', anchor: 'a1' },
      offset: { x: 3, z: -2 },  // y unnamed: it must land as 0, not drop the offset
    }]
    const { solver, captured } = makeCaptureSolver()
    await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    expect(captured.input!.mates[0].offset[0]).toBeCloseTo(3)
    expect(captured.input!.mates[0].offset[1]).toBeCloseTo(0)
    expect(captured.input!.mates[0].offset[2]).toBeCloseTo(-2)
  })

  it('apply transforms to vertices', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, makeTranslateSolver(10))

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
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1, {
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

  // ─── edge curves ───

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
        entityAnchors: { faces: [], edges: [], vertices: [] },
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
        entityAnchors: { faces: [], edges: [], vertices: [] },
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
        entityAnchors: { faces: [], edges: [], vertices: [] },
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

  // ─── posed anchors (Stage 7.5) ───

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
    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [{ handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() }]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, makeEchoSolver())

    expect(Object.keys(result.anchors['p1'].a1).sort()).toEqual(['axis', 'kind', 'point', 'x_axis'])
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

  // ─── stale ref detection ───

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

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_b')
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
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, doc_rev: number) =>
      makeDeterministicBundle(doc_id, doc_rev),
    )
    const idA = anchorIdFor('@gdf|0.000|0.000|0.000|0.000|0.000|1.000', 'point')
    const idB = anchorIdFor('@gdf|10.000|0.000|0.000|0.000|0.000|1.000', 'point')

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: idA }, ref_b: { part: 'p2', anchor: idB } },
    ]
    const revs = { 'doc-a': 1, 'doc-b': 1 }

    const r1 = await solveAssembly(parts, revs, mates, relay, makeEchoSolver())
    expect(r1.status.mates['m1'].stale).toBe(false)

    // A cache wipe strands the cached bundles; the cold rebuild must mint the
    // same deterministic ids, so the persisted refs still resolve.
    freshDb()
    const r2 = await solveAssembly(parts, revs, mates, relay, makeEchoSolver())
    expect(r2.status.mates['m1'].stale).toBe(false)
  })

  it('persisted mate refs survive a schema bump: the stale bundle still serves the remap chain', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, doc_rev: number) =>
      makeDeterministicBundle(doc_id, doc_rev),
    )
    // Both docs cached at the CURRENT rev but under the OLD schema: the
    // top-of-loop get reads them as misses (cold rebuild), and the migration
    // lookup must read them RAW so tier-1 geom_hash matching can re-key the
    // old random-id lineage onto the fresh deterministic ids.
    await bundleCachePut(makeBundle('doc-a', 1, { schema: BUNDLE_SCHEMA - 1 }))
    await bundleCachePut(makeBundle('doc-b', 1, { schema: BUNDLE_SCHEMA - 1 }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, makeEchoSolver())

    // The stale bundles were cold-rebuilt (relay called) and the remap chain
    // re-keyed the refs' random ids, so the mate is not stale-red.
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
    await bundleCachePut(makeBundle('doc-a', 1, {
      anchors: { legacy: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: g1, created_by: 'feat1' } },
    }))
    await bundleCachePut(makeBundle('doc-b', 1, {
      anchors: { legacy: { kind: 'point', point: [10, 0, 0], axis: [0, 0, 1], geom_hash: g2, created_by: 'feat1' } },
    }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      {
        id: 'm1', kind: 'spherical',
        ref_a: { part: 'p1', anchor: anchorIdFor(g1, 'point') },
        ref_b: { part: 'p2', anchor: anchorIdFor(g2, 'point') },
      },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, makeEchoSolver())

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
    await bundleCachePut(makeBundle('doc-a', 1, {
      anchors: {
        legacyA: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: g1, created_by: 'feat1' },
        legacyB: { kind: 'point', point: [5, 0, 0], axis: [0, 0, 1], geom_hash: g1, created_by: 'feat1' },
      },
    }))
    await bundleCachePut(makeBundle('doc-b', 1, {
      anchors: { legacy: { kind: 'point', point: [10, 0, 0], axis: [0, 0, 1], geom_hash: g2, created_by: 'feat1' } },
    }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates = [
      {
        id: 'm1', kind: 'spherical',
        ref_a: { part: 'p1', anchor: anchorIdFor(g1, 'point') },
        ref_b: { part: 'p2', anchor: anchorIdFor(g2, 'point') },
      },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_a')
  })

  it('does not re-parent a stale random id onto an unrelated anchor (deleted element stays stale)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    // A pre-deterministic mate ref (random id) whose element is genuinely gone:
    // no bundle anchor recomputes to it, so it stays stale-red instead of
    // re-parenting onto an unrelated anchor.
    const mates = [
      { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'legacyRandomId' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_a')
  })

  // ─── error handling ───

  it('degrades a rejecting bundle cache read to the cold rebuild path and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { relay, partDocs } = makeRelay()
      partDocs.set('doc-a', { kind: 'part', features: [] })
      vi.mocked(bundleCacheGet).mockRejectedValueOnce(new Error('quota exceeded'))

      const parts = [
        { handle: 'p1', doc_id: 'doc-a', doc_rev: 3, transform: identityTransform() },
      ]
      const result = await solveAssembly(parts, { 'doc-a': 3 }, [], relay, makeEchoSolver())

      // The solve itself succeeds via the relayed rebuild; an IndexedDB
      // failure must never surface as ok:false after that build was paid for.
      expect(result.transforms['p1']).toEqual(identityTransform())
      expect(result.bodies['p1']).toHaveLength(1)
      expect(relay.requestBuildBundle).toHaveBeenCalledWith('doc-a', 3, expect.any(Object))
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
        { handle: 'p1', doc_id: 'doc-a', doc_rev: 3, transform: identityTransform() },
      ]
      const result = await solveAssembly(parts, { 'doc-a': 3 }, [], relay, makeEchoSolver())

      expect(result.transforms['p1']).toEqual(identityTransform())
      expect(result.bodies['p1']).toHaveLength(1)
      // The write failure costs one cold rebuild later, not this solve.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('put failed')
    } finally {
      warn.mockRestore()
    }
  })

  it('skips anchor migration without failing when the migration lookup rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { relay, partDocs } = makeRelay()
      partDocs.set('doc-a', { kind: 'part', features: [] })
      await bundleCachePut(makeDeterministicBundle('doc-a', 3))
      vi.mocked(bundleCacheLatestRev).mockRejectedValueOnce(new Error('db closed'))

      const parts = [
        { handle: 'p1', doc_id: 'doc-a', doc_rev: 800, transform: identityTransform() },
      ]
      const result = await solveAssembly(parts, { 'doc-a': 800 }, [], relay, makeEchoSolver())

      // No migration lookup ran; deterministic ids make the fresh build's
      // anchors correct anyway.
      expect(result.transforms['p1']).toEqual(identityTransform())
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('returns seed transforms when solver is null', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })

    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: translationTransform(1, 2, 3) },
    ]
    const result = await solveAssembly(parts, { 'doc-a': 1 }, [], relay, null)

    expect(result.transforms['p1']).toEqual(translationTransform(1, 2, 3))
    expect(result.status.verdict).toBe('none')
    expect(result.status.error).toBeUndefined()
  })

  it('reports an unavailable solver when solver is null but mates exist', async () => {
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
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, null)

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

  // ─── assembly built-ins as ground (Stage 6c) ───

  it('resolves a fixed mate from a part to the assembly Top plane through assemblyAnchors', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeAxialBundle('doc-a', 1))

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
    expect(result.status.mates['m1'].stale).toBe(false)
    expect(result.transforms).toHaveProperty('p1')
    // The assembly frame is synthetic: it never appears as an output transform.
    expect(result.transforms).not.toHaveProperty(ASSEMBLY_HANDLE)

    // The solver saw the part body (0) + a pinned assembly frame body (1).
    expect(captured.input!.nBodies).toBe(2)
    expect(captured.input!.fixedMask[0] & 0b10).toBe(0b10)  // body 1 pinned

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

    expect(result.status.mates['m1'].stale).toBe(true)
    expect(result.status.mates['m1'].staleRefs).toContain('ref_b')
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

    expect(result.status.mates['bad'].stale).toBe(true)
    expect(result.status.mates['bad'].error).toContain('not_a_real_kind')
    expect(result.status.mates['ok'].stale).toBe(false)
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

    expect(result.status.mates['bad'].stale).toBe(true)
    expect(result.status.mates['bad'].error).toContain('not_a_real_anchor_kind')
    expect(result.status.mates['ok'].stale).toBe(false)
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('refuses an unresolved expression-valued parameter instead of reading it as zero', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates: MateSpec[] = [
      {
        id: 'bad', kind: 'fixed',
        ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' },
        angle: 'w / 2',
      },
      { id: 'ok', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a2' }, ref_b: { part: 'p2', anchor: 'a2' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    expect(result.status.mates['bad'].stale).toBe(true)
    expect(result.status.mates['bad'].error).toContain('angle')
    expect(result.status.mates['ok'].stale).toBe(false)
    // The bad mate contributes zero bytes to the encoded buffer: it is not
    // coerced to angle 0 and encoded as a success.
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('refuses an axis-reading mate whose anchor has no meaningful axis, but keeps spherical legal', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    // makeBundle's a1/a2 are vertex anchors: their axis is the [0, 0, 1]
    // placeholder, not geometry.
    await bundleCachePut(makeBundle('doc-a', 1))
    await bundleCachePut(makeBundle('doc-b', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const mates: MateSpec[] = [
      { id: 'rotating', kind: 'rotating', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
      { id: 'spherical', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a2' }, ref_b: { part: 'p2', anchor: 'a2' } },
    ]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, solver)

    expect(result.status.mates['rotating'].stale).toBe(true)
    expect(result.status.mates['rotating'].error).toContain('axis')
    // The placeholder-axis mate is not encoded; spherical, which never reads an
    // axis, still solves.
    expect(captured.input!.mates).toHaveLength(1)
    expect(result.status.mates['spherical'].stale).toBe(false)
  })

  it('keeps an axis-reading mate with an inline anchor legal (the drag objective authors its own axis)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
    ]
    // The triad drag objective: a fixed mate whose anchors are synthetic points
    // carrying an authored axis. A point kind here is not a B-rep placeholder.
    const mates: MateSpec[] = [{
      id: 'drag',
      kind: 'fixed',
      ref_a: { part: ASSEMBLY_HANDLE, anchor: 'drag', inlineAnchor: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '', created_by: 'drag' } },
      ref_b: { part: 'p1', anchor: 'drag', inlineAnchor: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '', created_by: 'drag' } },
    }]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': 1 }, mates, relay, solver)

    expect(result.status.mates['drag'].stale).toBe(false)
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('trusts the assembly frame origin axis even though its kind is a point', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeAxialBundle('doc-a', 1))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
    ]
    // The assembly origin is a point anchor with a deliberately canonical +Z,
    // so a revolute joint to it is legal even though a PART vertex point is not.
    const mates: MateSpec[] = [{
      id: 'm1', kind: 'rotating',
      ref_a: { part: 'p1', anchor: 'a1' },
      ref_b: { part: ASSEMBLY_HANDLE, anchor: ASSEMBLY_ORIGIN_ID },
    }]
    const { solver, captured } = makeCaptureSolver()
    const result = await solveAssembly(parts, { 'doc-a': 1 }, mates, relay, solver)

    expect(result.status.mates['m1'].stale).toBe(false)
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

    expect(result.status.mates['self'].stale).toBe(true)
    expect(result.status.mates['self'].error).toBe('a mate needs two different parts')
    expect(result.status.mates['ok'].stale).toBe(false)
    expect(captured.input!.mates).toHaveLength(1)
  })

  it('reports a failed solve and falls back to seed transforms when the solve output has the wrong param count', async () => {
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
      w.setUint32(0, 0x3252_544D, true)  // MATE_MAGIC_OUT
      w.setUint32(4, 7, true)  // nParams = 7, but the caller expects 14
      w.setUint8(8, 0)
      return new Uint8Array(w.buffer)
    }
    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, shortSolver)

    expect(result.status.verdict).toBe('failed')
    expect(result.status.error).toContain('params')
    expect(result.status.mates['m1'].error).toContain('params')
    expect(result.transforms['p2']).toEqual(translationTransform(5, 0, 0))
  })

  it('isolates a part whose bundle cannot be built and keeps the healthy parts solved', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-good', { kind: 'part', features: [] })
    // doc-bad is deliberately absent: requestPartDoc rejects with "not found".
    await bundleCachePut(makeBundle('doc-good', 1))

    const parts = [
      { handle: 'hGood', doc_id: 'doc-good', doc_rev: 1, transform: identityTransform() },
      { handle: 'hBad', doc_id: 'doc-bad', doc_rev: 1, transform: translationTransform(9, 0, 0) },
    ]

    const result = await solveAssembly(parts, { 'doc-good': 1, 'doc-bad': 1 }, [], relay, makeEchoSolver())

    expect(result.status.parts['hBad']).toEqual({ failed: true, error: expect.stringContaining('not found') })
    expect(result.status.parts['hGood']?.failed).toBeFalsy()
    expect(result.transforms['hGood']).toEqual(identityTransform())
    // A failed part keeps its seed placement so the document does not lose it.
    expect(result.transforms['hBad']).toEqual(translationTransform(9, 0, 0))
    expect(result.bodies['hGood']).toHaveLength(1)
    expect(result.bodies['hBad']).toEqual([])
    expect(partFailure('hBad', result.status).failed).toBe(true)
    expect(partFailure('hGood', result.status).failed).toBe(false)
  })

  it('names an unsupported mate kind through the status carrier', async () => {
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
      { id: 'm1', kind: 'worm_gear', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a1' } },
    ]

    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, makeEchoSolver())

    expect(result.status.mates['m1']).toEqual({ stale: true, error: "unsupported mate kind 'worm_gear'" })
    expect(mateFailure('m1', result.status)).toMatchObject({
      failed: true, level: 'error', message: "unsupported mate kind 'worm_gear'",
    })
  })

  it('marks a mate whose solver trapped even without a stale flag, and sets stale too', async () => {
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
    const trapping = () => { throw new Error('bad mate output magic') }

    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, trapping)

    expect(result.status.mates['m1'].error).toContain('bad mate output magic')
    expect(result.status.mates['m1'].stale).toBe(true)
    expect(mateFailure('m1', result.status)).toMatchObject({
      failed: true, level: 'error', message: 'bad mate output magic',
    })
  })

  it('carries an overconstrained verdict with its residual in the status', async () => {
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
    // The echo solver with status code 2 (overconstrained) and a nonzero
    // residual: the real-WASM counterpart lives in solveAssemblyReal.test.ts.
    const overSolver = (input: Uint8Array): Uint8Array => {
      const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
      const nBodies = view.getUint32(4, true)
      const nParams = nBodies * 7
      const paramsOffset = 20 + nBodies * 4
      const outSize = 4 + 4 + 1 + nParams * 4 + 4 + 28  // +4 for the n_mates header
      const out = new DataView(new ArrayBuffer(outSize))
      let pos = 0
      out.setUint32(pos, 0x3252544D, true); pos += 4
      out.setUint32(pos, nParams, true); pos += 4
      out.setUint8(pos, 2); pos += 1
      for (let i = 0; i < nParams; i++) { out.setFloat32(pos, view.getFloat32(paramsOffset + i * 4, true), true); pos += 4 }
      out.setUint32(pos, 0, true); pos += 4  // n_mates
      out.setFloat64(pos, 0.5, true); pos += 8
      out.setUint32(pos, 13, true); pos += 4
      out.setUint32(pos, 0, true); pos += 4
      out.setUint32(pos, 1, true); pos += 4
      out.setFloat64(pos, 0.001, true); pos += 8
      return new Uint8Array(out.buffer)
    }

    const result = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, overSolver)

    expect(result.status.verdict).toBe('overconstrained')
    expect(result.status.residualNorm).toBeGreaterThan(0)
  })

  // ─── fixed instances (Stage 6d) ───

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
    expect(captured.input!.fixedMask[0] & 0b01).toBe(0b01)  // body 0 pinned
    expect(captured.input!.fixedMask[0] & 0b10).toBe(0)     // body 1 free
  })

  it('pins the fixed part alongside the assembly frame when a mate uses both', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    await bundleCachePut(makeAxialBundle('doc-a', 1))

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

describe('anchor descriptor fallback (C7)', () => {
  // A relay whose doc-a anchor is positional and moves with the rev: rev 1 sits
  // at [0,0,0], rev 2+ at [5,0,0]. Same created_by + kind, so after the move
  // only tier 2 can re-find it. Doc-b keeps makeBundle's default anchors.
  function relayWithMovingAnchor(relay: RelayService): void {
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, doc_rev: number) => {
      if (doc_id === 'doc-a') {
        const x = doc_rev >= 2 ? 5 : 0
        return makeBundle('doc-a', doc_rev, {
          anchors: {
            aMoved: { kind: 'point', point: [x, 0, 0], axis: [0, 0, 1], geom_hash: `@gdf|x${x}`, created_by: 'feat1' },
          },
        })
      }
      return makeBundle('doc-b', doc_rev)
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
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]

    // Rev 1 warms the cache. The mock keys the anchor `aMoved`, so the ref's
    // deterministic id misses the dict and anchorByGeomHash re-parents it onto
    // the geohash-identical anchor, which is the path this warm solve proves.
    const warm = makeCaptureSolver()
    const r1 = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, warm.solver)
    expect(r1.status.mates['m1'].stale).toBe(false)
    expect(warm.captured.input!.mates[0].pointA[0]).toBeCloseTo(0)

    // Wipe, then rebuild at the moved rev: the old id is gone and no cached
    // predecessor exists, so only the descriptor can re-find the element.
    freshDb()
    const cold = makeCaptureSolver()
    const r2 = await solveAssembly(parts, { 'doc-a': 2, 'doc-b': 1 }, mates, relay, cold.solver)
    expect(r2.status.mates['m1'].stale).toBe(false)
    expect(cold.captured.input!.mates[0].pointA[0]).toBeCloseTo(5)
  })

  it('produces a descriptor through the build-time remap and it survives a later cache wipe', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })

    // A doc-a build whose single positional face anchor moves with the rev and
    // whose entity index names that anchor, so the pick path can be exercised.
    const movingFaceBundle = (doc_id: string, doc_rev: number): PartBundle => {
      const x = doc_rev >= 2 ? 5 : 0
      const geom = `@gdf|x${x}`
      const id = anchorIdFor(geom, 'point')
      return makeBundle(doc_id, doc_rev, {
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
      async (doc_id: string, doc_rev: number) =>
        doc_id === 'doc-a' ? movingFaceBundle('doc-a', doc_rev) : makeBundle('doc-b', doc_rev),
    )

    // Warm a rev-1 bundle so the rev-2 solve finds a remap seed: the build-time
    // tier-2 remap re-keys the fresh anchor id onto this prior id.
    const priorId = anchorIdFor('@gdf|x0', 'point')
    await bundleCachePut(makeBundle('doc-a', 1, {
      bodies: [{
        mesh: {
          vertices: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0]),
          indices: new Uint32Array([0, 1, 2, 1, 3, 2]),
          faceIdsPerTriangle: new Uint32Array([0, 0]),
        },
        edges: [],
        entityAnchors: { faces: [[priorId]], edges: [], vertices: [] },
      }],
      anchors: { [priorId]: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|x0', created_by: 'feat1' } },
    }))

    const parts = [
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]
    const solved = await solveAssembly(parts, { 'doc-a': 2, 'doc-b': 1 }, [], relay, makeEchoSolver())

    // The remap ran, so the pick path stamps the prior id with the descriptor
    // of the current (moved) anchor the remap re-keyed onto it.
    const refs = buildEntityMateRefs(solved.bodies, solved.anchorDescriptors)
    const ref = refs[assemblyEntityKey('p1', 0, 'face', 0)][0]
    expect(ref.anchor).toBe(priorId)
    expect(ref.anchor_descriptor).toEqual({
      geom_hash: '@gdf|x5', kind: 'point', created_by: 'feat1', point: [5, 0, 0],
    })

    // That stamped ref survives a cache wipe: the cold rebuild has no remap
    // seed, so only the descriptor re-finds the moved element.
    freshDb()
    const mates = [{
      id: 'm1', kind: 'spherical',
      ref_a: { part: 'p1', anchor: ref.anchor, anchor_descriptor: ref.anchor_descriptor },
      ref_b: { part: 'p2', anchor: 'a2' },
    }]
    const cold = makeCaptureSolver()
    const r2 = await solveAssembly(parts, { 'doc-a': 2, 'doc-b': 1 }, mates, relay, cold.solver)
    expect(r2.status.mates['m1'].stale).toBe(false)
    expect(cold.captured.input!.mates[0].pointA[0]).toBeCloseTo(5)
  })

  it('re-finds the named one of two same-kind anchors after a move (required test 2)', async () => {
    const { relay, partDocs } = makeRelay()
    partDocs.set('doc-a', { kind: 'part', features: [] })
    partDocs.set('doc-b', { kind: 'part', features: [] })
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, doc_rev: number) => {
      if (doc_id === 'doc-a') {
        const aX = doc_rev >= 2 ? 5 : 0
        return makeBundle('doc-a', doc_rev, {
          anchors: {
            aNamed: { kind: 'point', point: [aX, 0, 0], axis: [0, 0, 1], geom_hash: `@gdf|a${aX}`, created_by: 'feat1' },
            aSibling: { kind: 'point', point: [10, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|a10', created_by: 'feat1' },
          },
        })
      }
      return makeBundle('doc-b', doc_rev)
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
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]

    const warm = makeCaptureSolver()
    const r1 = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, warm.solver)
    expect(r1.status.mates['m1'].stale).toBe(false)
    expect(warm.captured.input!.mates[0].pointA[0]).toBeCloseTo(0)

    freshDb()
    const cold = makeCaptureSolver()
    const r2 = await solveAssembly(parts, { 'doc-a': 2, 'doc-b': 1 }, mates, relay, cold.solver)
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
    vi.mocked(relay.requestBuildBundle).mockImplementation(async (doc_id: string, doc_rev: number) => {
      if (doc_id === 'doc-a') {
        return makeBundle('doc-a', doc_rev, {
          anchors: {
            aCandidate: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '@gdf|a0', created_by: 'feat1' },
          },
        })
      }
      return makeBundle('doc-b', doc_rev)
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
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 2, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]

    const result = await solveAssembly(parts, { 'doc-a': 2, 'doc-b': 1 }, mates, relay, makeEchoSolver())

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
      { handle: 'p1', doc_id: 'doc-a', doc_rev: 1, transform: identityTransform() },
      { handle: 'p2', doc_id: 'doc-b', doc_rev: 1, transform: translationTransform(5, 0, 0) },
    ]

    const r1 = await solveAssembly(parts, { 'doc-a': 1, 'doc-b': 1 }, mates, relay, makeEchoSolver())
    expect(r1.status.mates['m1'].stale).toBe(false)

    freshDb()
    const r2 = await solveAssembly(parts, { 'doc-a': 2, 'doc-b': 1 }, mates, relay, makeEchoSolver())
    expect(r2.status.mates['m1'].stale).toBe(true)
    expect(r2.status.mates['m1'].staleRefs).toContain('ref_a')
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
    const fixture = readMateWireFixture()
    // The rev and both magics are pinned here as literals as well as through the
    // fixture, so a stale fixture cannot hide a constant that moved on one side.
    expect(fixture.rev).toBe(3)
    expect(fixture.magic).toBe(0x3353544D)
    expect(fixture.magic_out).toBe(0x3252544D)
    // One empty body, no mates: header 20 + bodies 4 + params 28 + mask 1 = 53 bytes
    const params = new Float32Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [])
    expect(encoded.length).toBe(53)
    // The input magic is the version handshake; Rust rejects any other value.
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getUint32(0, true)).toBe(fixture.magic)

    // One mate record adds exactly the fixture stride (112 bytes).
    const encodedWithMate = encodeMateInput(1, params, fixedMask, [{
      kindCode: 1,
      bodyA: 0, bodyB: 0,
      anchorKindA: 6, anchorKindB: 6,
      pointA: [0, 0, 0], axisA: [0, 0, 1],
      pointB: [1, 0, 0], axisB: [0, 0, 1],
      flip: false, offset: [0, 0, 0], ratio: 1, radius: 0, angle: 0,
      perpA: [0, 1, 0], perpB: [0, 1, 0], weight: 1,
    }])
    expect(encodedWithMate.length - encoded.length).toBe(fixture.record_bytes)
  })

  it('places angle at the documented offset in the mate record', () => {
    // Record layout after the 53-byte header+body+params+mask prefix (1 body):
    // kind(1) + bodyA(4) + bodyB(4) + anchorKinds(2) + pointA(12) + axisA(12)
    // + pointB(12) + axisB(12) + flags(1) + offset(12) + ratio(4) + radius(4) = 80,
    // then angle is the f32 at byte 80, followed by the two perp triples and the
    // weight. The offset is three f32s, so this is 8 bytes past where the scalar
    // form put it.
    const params = new Float32Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [{
      kindCode: 0,
      bodyA: 0, bodyB: 0,
      anchorKindA: 0, anchorKindB: 0,
      pointA: [0, 0, 0], axisA: [0, 0, 1],
      pointB: [0, 0, 0], axisB: [0, 0, 1],
      flip: false, offset: [0, 0, 0], ratio: 1, radius: 0, angle: Math.PI / 4,
      perpA: [0, 1, 0], perpB: [0, 1, 0], weight: 1,
    }])
    const recordStart = 53
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getFloat32(recordStart + 80, true)).toBeCloseTo(Math.PI / 4)
  })

  it('writes perp_a, perp_b then weight after angle, in that order', () => {
    // Distinct perps and a non-default weight, read back by their exact record
    // offsets: a swapped or mis-sized tail write is invisible when both sides
    // share the +Z default and weight 1 every real-WASM row uses.
    const params = new Float32Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [{
      kindCode: 0,
      bodyA: 0, bodyB: 0,
      anchorKindA: 0, anchorKindB: 0,
      pointA: [0, 0, 0], axisA: [0, 0, 1],
      pointB: [0, 0, 0], axisB: [0, 0, 1],
      flip: false, offset: [0, 0, 0], ratio: 1, radius: 0, angle: 0,
      perpA: [1, 0, 0], perpB: [0, 0, 1], weight: 0.25,
    }])
    // angle ends at record byte 84; perp_a is 84..96, perp_b is 96..108, and the
    // weight f32 is the last field at 108..112.
    const recordStart = 53
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getFloat32(recordStart + 84, true)).toBe(1)
    expect(view.getFloat32(recordStart + 88, true)).toBe(0)
    expect(view.getFloat32(recordStart + 92, true)).toBe(0)
    expect(view.getFloat32(recordStart + 96, true)).toBe(0)
    expect(view.getFloat32(recordStart + 100, true)).toBe(0)
    expect(view.getFloat32(recordStart + 104, true)).toBe(1)
    expect(view.getFloat32(recordStart + 108, true)).toBeCloseTo(0.25)
  })
})
