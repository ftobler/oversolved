/**
 * Unit tests for the anchor solver worker handlers. Tests focus on the handler
 * layer: WASM loading, solveAssembly orchestration call, and response wrapping.
 * The solveAssembly function and WASM module are mocked so tests stay pure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  handleSolveAssembly,
  handleRelayResponse,
  createRelayService,
  RELAY_TIMEOUT_MS,
  WorkerActor,
} from './anchorSolverWorker'
import type {
  SolveAssemblyRequest,
  AssemblySolveOkResponse,
  AnchorRelayRequest,
} from './solverProtocol'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { bundleCachePut, bundleCacheGet, resetBundleDbConnection } from '../bundleCache'
import { BUNDLE_SCHEMA, type PartBundle } from '../partBundle'

vi.mock('../../wasm-kernel/anchorSolver', () => ({
  initAnchorSolver: vi.fn().mockResolvedValue(undefined),
  getMateSolver: vi.fn().mockReturnValue(null),
}))

vi.mock('../solveAssembly', () => ({
  solveAssembly: vi.fn().mockResolvedValue({
    transforms: {},
    bodies: {},
    mateResults: {},
  }),
}))

import { solveAssembly } from '../solveAssembly'

function makeReq(overrides?: Partial<SolveAssemblyRequest>): SolveAssemblyRequest {
  return {
    id: 1,
    kind: 'solveAssembly',
    assemblyId: 'asm-1',
    parts: [
      {
        handle: 'p1',
        doc_id: 'doc-a',
        doc_rev: 3,
        transform: { tx: 1, ty: 2, tz: 3, qx: 0, qy: 0, qz: 0, qw: 1 },
      },
      {
        handle: 'p2',
        doc_id: 'doc-b',
        doc_rev: 5,
        transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      },
    ],
    revs: { 'doc-a': 3, 'doc-b': 5 },
    mates: [],
    ...overrides,
  }
}

function fakeRelay(): { service: ReturnType<typeof createRelayService>; requests: AnchorRelayRequest[] } {
  const requests: AnchorRelayRequest[] = []
  const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
  return { service: createRelayService(post), requests }
}

function makeBundle(doc_id: string, doc_rev: number): PartBundle {
  return {
    doc_id,
    doc_rev,
    schema: BUNDLE_SCHEMA,
    bodies: [
      {
        mesh: {
          vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          indices: new Uint32Array([0, 1, 2]),
          faceIdsPerTriangle: new Uint32Array([0]),
        },
        edges: [],
        entityAnchors: { faces: [], edges: [], vertices: [] },
      },
    ],
    anchors: {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleSolveAssembly', () => {
  it('delegates to solveAssembly with parts, revs, mates, relay, solver', async () => {
    const relay = fakeRelay()
    const req = makeReq({
      mates: [
        { id: 'm1', kind: 'spherical', ref_a: { part: 'p1', anchor: 'a1' }, ref_b: { part: 'p2', anchor: 'a2' } },
      ],
    })

    const mockSolver = vi.fn()
    const { getMateSolver } = await import('../../wasm-kernel/anchorSolver')
    vi.mocked(getMateSolver).mockReturnValue(mockSolver)

    await handleSolveAssembly(req, relay.service)

    expect(solveAssembly).toHaveBeenCalledWith(
      req.parts,
      req.revs,
      req.mates,
      relay.service,
      mockSolver,
    )
  })

  it('wraps solveAssembly result into ok response', async () => {
    const relay = fakeRelay()
    const mockResult = {
      transforms: { p1: { tx: 5, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
      bodies: { p1: [] },
      anchors: {},
      mateResults: { m1: { stale: false } },
    }
    vi.mocked(solveAssembly).mockResolvedValue(mockResult)

    const res = await handleSolveAssembly(makeReq(), relay.service)
    expect(res.ok).toBe(true)
    const payload = (res as AssemblySolveOkResponse).payload
    expect(payload.transforms).toEqual(mockResult.transforms)
    expect(payload.bodies).toEqual(mockResult.bodies)
    expect(payload.mateResults).toEqual(mockResult.mateResults)
  })

  it('preserves request id in response', async () => {
    const relay = fakeRelay()
    const res = await handleSolveAssembly(makeReq({ id: 42 }), relay.service)
    expect(res.id).toBe(42)
  })

  it('returns error when handler throws', async () => {
    const relay = fakeRelay()
    vi.mocked(solveAssembly).mockRejectedValue(new Error('WASM init failed'))

    const res = await handleSolveAssembly(makeReq(), relay.service)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('WASM init failed')
    }
  })
})

describe('relay plumbing', () => {
  it('relayRequest resolves when relay response arrives', async () => {
    const requests: AnchorRelayRequest[] = []
    const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
    const relay = createRelayService(post)

    const prom = relay.requestPartDoc('my-doc-id')

    expect(requests).toHaveLength(1)
    expect(requests[0].kind).toBe('asr_relay')
    expect(requests[0].subKind).toBe('partDocContent')
    expect(requests[0].doc_id).toBe('my-doc-id')

    handleRelayResponse({
      kind: 'asr_relayRes',
      requestId: requests[0].requestId,
      ok: true,
      payload: { features: [] },
    })

    const result = await prom
    expect(result).toEqual({ features: [] })
  })

  it('relayRequest rejects when relay response has error', async () => {
    const requests: AnchorRelayRequest[] = []
    const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
    const relay = createRelayService(post)

    const prom = relay.requestBuildBundle('doc', 1, {})

    handleRelayResponse({
      kind: 'asr_relayRes',
      requestId: requests[0].requestId,
      ok: false,
      error: 'bundle build failed',
    })

    await expect(prom).rejects.toThrow('bundle build failed')
  })

  it('relayRequest for buildBundle carries correct parameters', async () => {
    const requests: AnchorRelayRequest[] = []
    const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
    const relay = createRelayService(post)

    relay.requestBuildBundle('doc-x', 7, { key: 'val' })
    expect(requests).toHaveLength(1)
    expect(requests[0].subKind).toBe('buildBundle')
    expect(requests[0].doc_id).toBe('doc-x')
    expect(requests[0].doc_rev).toBe(7)
    expect(requests[0].spec).toEqual({ key: 'val' })
  })

  it('handleRelayResponse is a no-op for unknown requestId', () => {
    expect(() => handleRelayResponse({
      kind: 'asr_relayRes',
      requestId: 9999,
      ok: true,
      payload: null,
    })).not.toThrow()
  })

  it('multiple concurrent relay requests are independent', async () => {
    const requests: AnchorRelayRequest[] = []
    const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
    const relay = createRelayService(post)

    const p1 = relay.requestPartDoc('d1')
    const p2 = relay.requestPartDoc('d2')

    expect(requests).toHaveLength(2)

    handleRelayResponse({ kind: 'asr_relayRes', requestId: requests[1].requestId, ok: true, payload: 'two' })
    handleRelayResponse({ kind: 'asr_relayRes', requestId: requests[0].requestId, ok: true, payload: 'one' })

    await expect(p1).resolves.toBe('one')
    await expect(p2).resolves.toBe('two')
  })

  it('relayRequest rejects on its own if the main thread never responds', async () => {
    vi.useFakeTimers()
    try {
      const post = (): void => {}
      const relay = createRelayService(post)

      const prom = relay.requestPartDoc('never-answered')
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('a late relay response after the timeout already fired is a no-op', async () => {
    vi.useFakeTimers()
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post)

      const prom = relay.requestPartDoc('slow-doc')
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS)
      await assertion

      expect(() => handleRelayResponse({
        kind: 'asr_relayRes',
        requestId: requests[0].requestId,
        ok: true,
        payload: 'too-late',
      })).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a buildBundle relay reply that arrived via transfer still resolves to a usable, cacheable bundle', async () => {
    // Fresh IndexedDB for the cache round-trip below.
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()

    const requests: AnchorRelayRequest[] = []
    const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
    const relay = createRelayService(post)

    const prom = relay.requestBuildBundle('doc-a', 1, {})

    // The main thread transfers the bundle buffers to this worker: the transfer
    // detaches the source and the worker receives a fresh copy with full data.
    const bundle = makeBundle('doc-a', 1)
    const mesh = bundle.bodies[0].mesh
    const transfer = [mesh.vertices.buffer, mesh.indices.buffer, mesh.faceIdsPerTriangle.buffer]
    const fresh = structuredClone(bundle, { transfer }) as PartBundle

    // Source detached, exactly as a real postMessage(..., transfer) leaves it.
    expect(transfer[0].byteLength).toBe(0)
    expect(transfer[1].byteLength).toBe(0)
    expect(transfer[2].byteLength).toBe(0)

    handleRelayResponse({
      kind: 'asr_relayRes',
      requestId: requests[0].requestId,
      ok: true,
      payload: fresh,
    })

    const received = await prom as PartBundle
    expect(received.bodies[0].mesh.vertices.byteLength).toBeGreaterThan(0)
    expect(received.bodies[0].mesh.indices.byteLength).toBeGreaterThan(0)
    expect(Array.from(received.bodies[0].mesh.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])

    // The anchor worker caches what it received; the round-trip keeps the mesh
    // bytes intact, so a subsequent solve reads real geometry, not detritus.
    await bundleCachePut(received)
    const loaded = await bundleCacheGet('doc-a', 1)
    expect(loaded).toBeDefined()
    expect(loaded && Array.from(loaded.bodies[0].mesh.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(loaded && loaded.bodies[0].mesh.indices.byteLength).toBeGreaterThan(0)
  })
})

describe('relay requestId scoping across worker generations', () => {
  it('a stale reply with a colliding requestId cannot resolve a respawned entry', async () => {
    vi.useFakeTimers()
    try {
      // Generation 1: the crashed worker. Its client had issued solve id 1,
      // so its relay ids sit in the 1000 band.
      vi.resetModules()
      const gen1 = await import('./anchorSolverWorker')
      const r1: AnchorRelayRequest[] = []
      const service1 = gen1.createRelayService((m) => r1.push(m))
      await gen1.handleSolveAssembly(makeReq({ id: 1 }), service1)
      const staleProm = service1.requestPartDoc('old-doc')
      const staleId = r1[0].requestId
      const staleRejects = expect(staleProm).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(gen1.RELAY_TIMEOUT_MS)
      await staleRejects

      // Generation 2: the respawned worker. The client's nextId has grown, so
      // its relay ids sit in a higher band and cannot collide.
      vi.resetModules()
      const gen2 = await import('./anchorSolverWorker')
      const r2: AnchorRelayRequest[] = []
      const service2 = gen2.createRelayService((m) => r2.push(m))
      await gen2.handleSolveAssembly(makeReq({ id: 2 }), service2)
      const liveProm = service2.requestPartDoc('new-doc')
      const liveId = r2[0].requestId

      expect(liveId).not.toBe(staleId)

      // A stale reply from gen 1 misdelivered to gen 2 must not touch gen 2's
      // live entry: it only resolves with its own id and payload.
      gen2.handleRelayResponse({ kind: 'asr_relayRes', requestId: staleId, ok: true, payload: 'WRONG DOC' })
      gen2.handleRelayResponse({ kind: 'asr_relayRes', requestId: liveId, ok: true, payload: 'RIGHT DOC' })
      await expect(liveProm).resolves.toBe('RIGHT DOC')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WorkerActor', () => {
  it('runs jobs serialized, one after another', async () => {
    const actor = new WorkerActor()
    const order: number[] = []
    actor.run(() => Promise.resolve(1), (res) => order.push(res))
    actor.run(() => Promise.resolve(2), (res) => order.push(res))
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    expect(order).toEqual([1, 2])
  })

  it('a job whose respond throws does not prevent the next job from running', async () => {
    const actor = new WorkerActor()
    const errors: unknown[] = []
    let secondRan = false

    actor.run(
      () => Promise.resolve('first'),
      () => { throw new Error('respond blew up (e.g. non-cloneable payload)') },
      (err) => errors.push(err),
    )
    actor.run(
      () => Promise.resolve('second'),
      () => { secondRan = true },
    )

    // Let both queued .then/.catch links settle.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    expect(errors).toHaveLength(1)
    expect(secondRan).toBe(true)
  })
})
