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
  BUILD_BUNDLE_TIMEOUT_SCALE,
  LATE_RELAY_GRACE_MS,
  WorkerActor,
  handleWorkerMessage,
} from './anchorSolverWorker'
import type {
  SolveAssemblyRequest,
  AssemblySolveOkResponse,
  AnchorRelayRequest,
  AssemblyWorkerRequest,
  AssemblyWorkerResponse,
} from './solverProtocol'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { bundleCachePut, bundleCachePutIfAbsent, bundleCacheGet, resetBundleDbConnection } from '../bundleCache'
import { BUNDLE_SCHEMA, type Anchor, type PartBundle } from '../partBundle'

vi.mock('../../wasm-kernel/anchorSolver', () => ({
  initAnchorSolver: vi.fn().mockResolvedValue(undefined),
  getMateSolver: vi.fn().mockReturnValue(null),
  getMateSolverLive: vi.fn().mockReturnValue(null),
}))

vi.mock('../solveAssembly', () => ({
  solveAssembly: vi.fn().mockResolvedValue({
    transforms: {},
    bodies: {},
    anchors: {},
    anchorDescriptors: {},
    status: { verdict: 'none', residualNorm: 0, rank: 0, dof: 0, iters: 0, mates: {}, parts: {} },
  }),
}))

// Wrap bundleCachePut in a delegating spy (real IndexedDB behaviour intact) so
// the late-relay tests can assert the timed-out build was cached. Mirrors the
// pattern solveAssembly.test.ts uses for bundleCacheGet/bundleCachePut.
vi.mock('../bundleCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bundleCache')>()
  return {
    ...actual,
    bundleCachePut: vi.fn(actual.bundleCachePut),
    bundleCachePutIfAbsent: vi.fn(actual.bundleCachePutIfAbsent),
  }
})

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
        transform: { tx: 1, ty: 2, tz: 3, qx: 0, qy: 0, qz: 0, qw: 1 },
      },
      {
        handle: 'p2',
        doc_id: 'doc-b',
        transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      },
    ],
    hashes: { 'doc-a': '3', 'doc-b': '5' },
    mates: [],
    ...overrides,
  }
}

function fakeRelay(): { service: ReturnType<typeof createRelayService>; requests: AnchorRelayRequest[] } {
  const requests: AnchorRelayRequest[] = []
  const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
  return { service: createRelayService(post), requests }
}

function makeBundle(doc_id: string, content_hash: string): PartBundle {
  return {
    doc_id,
    content_hash,
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
      req.hashes,
      req.mates,
      relay.service,
      mockSolver,
    )
  })

  it('routes a live request to the live solver entry point', async () => {
    const relay = fakeRelay()
    const fullSolver = vi.fn()
    const liveSolver = vi.fn()
    const mod = await import('../../wasm-kernel/anchorSolver')
    vi.mocked(mod.getMateSolver).mockReturnValue(fullSolver)
    vi.mocked(mod.getMateSolverLive).mockReturnValue(liveSolver)

    await handleSolveAssembly(makeReq({ live: true }), relay.service)
    expect(solveAssembly).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(), relay.service, liveSolver,
    )

    await handleSolveAssembly(makeReq({ live: false }), relay.service)
    expect(solveAssembly).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(), relay.service, fullSolver,
    )

    // A build without the live entry point falls back to the full solver.
    vi.mocked(mod.getMateSolverLive).mockReturnValue(null)
    await handleSolveAssembly(makeReq({ live: true }), relay.service)
    expect(solveAssembly).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(), relay.service, fullSolver,
    )
  })

  it('wraps solveAssembly result into ok response', async () => {
    const relay = fakeRelay()
    const mockResult = {
      transforms: { p1: { tx: 5, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
      bodies: { p1: [] },
      anchors: {},
      anchorDescriptors: {},
      status: {
        verdict: 'fully_constrained' as const, residualNorm: 0, rank: 0, dof: 0, iters: 0,
        mates: { m1: { stale: false } }, parts: {},
      },
    }
    vi.mocked(solveAssembly).mockResolvedValue(mockResult)

    const res = await handleSolveAssembly(makeReq(), relay.service)
    expect(res.ok).toBe(true)
    const payload = (res as AssemblySolveOkResponse).payload
    expect(payload.transforms).toEqual(mockResult.transforms)
    expect(payload.bodies).toEqual(mockResult.bodies)
    expect(payload.status).toEqual(mockResult.status)
    expect(payload.anchorDescriptors).toEqual(mockResult.anchorDescriptors)
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

    const prom = relay.requestBuildBundle('doc', '1', {})

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

    relay.requestBuildBundle('doc-x', '7', { key: 'val' })
    expect(requests).toHaveLength(1)
    expect(requests[0].subKind).toBe('buildBundle')
    expect(requests[0].doc_id).toBe('doc-x')
    expect(requests[0].content_hash).toBe('7')
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

  it('createRelayService accepts a per-service timeout override; the default is RELAY_TIMEOUT_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const post = (): void => {}
      const defaultRelay = createRelayService(post)
      const defaultProm = defaultRelay.requestPartDoc('default-doc')
      const defaultAsserts = expect(defaultProm).rejects.toThrow(/timed out after 30000ms/)
      await vi.advanceTimersByTimeAsync(RELAY_TIMEOUT_MS)
      await defaultAsserts

      const fastRelay = createRelayService(post, 250)
      const fastProm = fastRelay.requestPartDoc('fast-doc')
      const fastAsserts = expect(fastProm).rejects.toThrow(/timed out after 250ms/)
      await vi.advanceTimersByTimeAsync(250)
      await fastAsserts
    } finally {
      vi.useRealTimers()
    }
  })

  it('buildBundle gets a longer budget than partDocContent', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const post = (): void => {}
      const relay = createRelayService(post, 1000)
      const prom = relay.requestBuildBundle('doc-a', '1', {})
      const assertion = expect(prom).rejects.toThrow(/timed out/)

      let settled = false
      prom.then(() => { settled = true }, () => { settled = true })
      // At the partDoc budget the build is still pending; only the scaled
      // build budget fires the timeout.
      await vi.advanceTimersByTimeAsync(1000)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1000 * (BUILD_BUNDLE_TIMEOUT_SCALE - 1))
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('caches a late buildBundle reply after the timeout and keeps the promise rejected', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 1000)

      const prom = relay.requestBuildBundle('doc-a', '1', {})
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(2000)
      await assertion

      // The build finished just after its ceiling fired: the late reply must
      // be cached, not thrown away, so the next solve reuses the work. The
      // original promise already rejected and must not double-settle.
      const bundle = makeBundle('doc-a', '1')
      await handleRelayResponse({ kind: 'asr_relayRes', requestId: requests[0].requestId, ok: true, payload: bundle })
      expect(bundleCachePutIfAbsent).toHaveBeenCalledWith(bundle)
      const loaded = await bundleCacheGet('doc-a', '1')
      expect(loaded).toBeDefined()
      expect(loaded && loaded.bodies[0].mesh.vertices.byteLength).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a late partDocContent reply after the timeout is dropped, nothing is cached', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 1000)
      const prom = relay.requestPartDoc('slow-doc')
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion

      expect(() => handleRelayResponse({
        kind: 'asr_relayRes',
        requestId: requests[0].requestId,
        ok: true,
        payload: { features: [] },
      })).not.toThrow()
      // partDocContent has nothing to cache: the late reply is a pure drop.
      expect(bundleCachePut).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('evicts a timed-out buildBundle entry that never receives a reply', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 1000)
      const prom = relay.requestBuildBundle('doc-a', '1', {})
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(2000)
      await assertion

      // No reply arrived within the grace window: the entry self-evicts, so a
      // delivery after that can no longer cache anything.
      await vi.advanceTimersByTimeAsync(LATE_RELAY_GRACE_MS)
      handleRelayResponse({ kind: 'asr_relayRes', requestId: requests[0].requestId, ok: true, payload: makeBundle('doc-a', '1') })
      expect(bundleCachePut).not.toHaveBeenCalled()
      const loaded = await bundleCacheGet('doc-a', '1')
      expect(loaded).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not overwrite an already-cached bundle with a late reply', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 1000)

      // A concurrent solve already cached a bundle under the key, with anchors
      // the late raw reply does not carry.
      const cached = {
        ...makeBundle('doc-a', '1'),
        anchors: {
          a1: { kind: 'point', point: [1, 2, 3], axis: [0, 0, 1], geom_hash: 'g1', created_by: 'f1' } as Anchor,
        },
      }
      await bundleCachePut(cached)
      // The pre-cache put above is an expected call; clear it so the late-reply
      // guard below is the only thing under assertion.
      vi.mocked(bundleCachePut).mockClear()
      vi.mocked(bundleCachePutIfAbsent).mockClear()

      const prom = relay.requestBuildBundle('doc-a', '1', {})
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(2000)
      await assertion

      // The late raw reply must not clobber the already-cached record: the key
      // is already cached, so the if-absent salvage skips the write.
      await handleRelayResponse({ kind: 'asr_relayRes', requestId: requests[0].requestId, ok: true, payload: makeBundle('doc-a', '1') })
      expect(bundleCachePutIfAbsent).toHaveBeenCalled()
      expect(bundleCachePut).not.toHaveBeenCalled()
      const loaded = await bundleCacheGet('doc-a', '1')
      expect(loaded && loaded.anchors['a1'].point).toEqual([1, 2, 3])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a malformed late buildBundle reply (missing bodies) without caching', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 1000)
      const prom = relay.requestBuildBundle('doc-a', '1', {})
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(2000)
      await assertion

      // The main thread only relays a bundle whose payload has a `bodies`
      // array; a reply that fails that shape check is dropped, not cached.
      await handleRelayResponse({
        kind: 'asr_relayRes',
        requestId: requests[0].requestId,
        ok: true,
        payload: { doc_id: 'doc-a', content_hash: 'h1' },
      })
      expect(bundleCachePut).not.toHaveBeenCalled()
      const loaded = await bundleCacheGet('doc-a', '1')
      expect(loaded).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a late buildBundle reply whose content hash is unknown', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 1000)
      // A store read failure has no hash to key the build with, so the solve
      // sends '' and leaves the build uncached.
      const prom = relay.requestBuildBundle('doc-a', '', {})
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(2000)
      await assertion

      await handleRelayResponse({
        kind: 'asr_relayRes',
        requestId: requests[0].requestId,
        ok: true,
        payload: makeBundle('doc-a', ''),
      })
      // A `doc@` key could never be looked up; salvaging it would just eat one
      // of the per-doc eviction slots.
      expect(bundleCachePutIfAbsent).not.toHaveBeenCalled()
      const loaded = await bundleCacheGet('doc-a', '')
      expect(loaded).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a late buildBundle error reply without caching', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 1000)
      const prom = relay.requestBuildBundle('doc-a', '1', {})
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(2000)
      await assertion

      // An error reply carries no bundle to salvage; the late entry is dropped.
      await handleRelayResponse({
        kind: 'asr_relayRes',
        requestId: requests[0].requestId,
        ok: false,
        error: 'build failed',
      })
      expect(bundleCachePutIfAbsent).not.toHaveBeenCalled()
      expect(await bundleCacheGet('doc-a', '1')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a late buildBundle reply whose doc/hash does not match the request', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 1000)
      const prom = relay.requestBuildBundle('doc-a', '1', {})
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(2000)
      await assertion

      // A bundle for a different doc is not the work that was asked for;
      // caching it under doc-a@1 would serve wrong geometry to the next solve.
      await handleRelayResponse({
        kind: 'asr_relayRes',
        requestId: requests[0].requestId,
        ok: true,
        payload: makeBundle('doc-other', '1'),
      })
      expect(bundleCachePutIfAbsent).not.toHaveBeenCalled()
      expect(await bundleCacheGet('doc-a', '1')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('swallows a failed cache write when salvaging a late bundle', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 1000)
      const prom = relay.requestBuildBundle('doc-a', '1', {})
      const assertion = expect(prom).rejects.toThrow(/timed out/)
      await vi.advanceTimersByTimeAsync(2000)
      await assertion

      vi.mocked(bundleCachePutIfAbsent).mockRejectedValueOnce(new Error('idb quota exceeded'))
      // The solve already failed; a cache-write failure must not surface as an
      // unhandled rejection in the worker.
      await expect(handleRelayResponse({
        kind: 'asr_relayRes',
        requestId: requests[0].requestId,
        ok: true,
        payload: makeBundle('doc-a', '1'),
      })).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith('failed to cache a late relayed bundle', expect.any(Error))
    } finally {
      warn.mockRestore()
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

    const prom = relay.requestBuildBundle('doc-a', '1', {})

    // The main thread transfers the bundle buffers to this worker: the transfer
    // detaches the source and the worker receives a fresh copy with full data.
    const bundle = makeBundle('doc-a', '1')
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
    const loaded = await bundleCacheGet('doc-a', '1')
    expect(loaded).toBeDefined()
    expect(loaded && Array.from(loaded.bodies[0].mesh.vertices)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(loaded && loaded.bodies[0].mesh.indices.byteLength).toBeGreaterThan(0)
  })
})

describe('relay timeout + late bundle cache with solveAssembly', () => {
  // Real solveAssembly round-trips through fake-indexeddb, which schedules on
  // setImmediate; only setTimeout is faked here, so setImmediate still runs
  // natively. Poll the real condition instead of counting ticks: an IndexedDB
  // open chains several setImmediates, so a single flush is not enough.
  async function until(pred: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 500; i++) {
      if (await pred()) return
      await new Promise((resolve) => setImmediate(resolve))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  it('a re-solve after a timed-out then late-cached build hits the cache instead of rebuilding', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      // The file-level mock is only for the handler-level tests; this test
      // drives the real solveAssembly through the real relay service.
      const real = await vi.importActual<typeof import('../solveAssembly')>('../solveAssembly')

      const requests: AnchorRelayRequest[] = []
      const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
      const relay = createRelayService(post, 500)

      const parts = [
        { handle: 'p1', doc_id: 'doc-a', transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
      ]
      const revs = { 'doc-a': '1' }

      // First solve: bundle cache miss, part doc answered in time, the build
      // outruns its budget. The timeout is isolated to the part (per-part
      // failure isolation), so the solve resolves with a failed-part mark
      // instead of rejecting the whole assembly.
      const first = real.solveAssembly(parts, revs, [], relay, null)
      await until(() => requests.some(r => r.subKind === 'partDocContent'), 'part doc relay')
      const partDocReq = requests.find(r => r.subKind === 'partDocContent')!
      handleRelayResponse({ kind: 'asr_relayRes', requestId: partDocReq.requestId, ok: true, payload: { kind: 'part', features: [] } })
      await until(() => requests.some(r => r.subKind === 'buildBundle'), 'build bundle relay')
      const buildReq = requests.find(r => r.subKind === 'buildBundle')!
      await vi.advanceTimersByTimeAsync(1000)
      const firstRes = await first
      expect(firstRes.status.parts['p1']?.failed).toBe(true)

      // The finished build lands late and is cached instead of dropped.
      await handleRelayResponse({ kind: 'asr_relayRes', requestId: buildReq.requestId, ok: true, payload: makeBundle('doc-a', '1') })
      const loaded = await bundleCacheGet('doc-a', '1')
      expect(loaded).toBeDefined()

      // Second solve: the cache now serves the bundle, so no relay is needed,
      // not even the part-doc fetch.
      const second = real.solveAssembly(parts, revs, [], relay, null)
      const res = await second
      expect(res.bodies).toHaveProperty('p1')
      expect(requests.filter(r => r.subKind === 'buildBundle')).toHaveLength(1)
      expect(requests).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
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

  it('a respond throw plus an onError throw does not poison the chain', async () => {
    const actor = new WorkerActor()
    const onErrorCalls: unknown[] = []
    let secondRan = false

    actor.run(
      () => Promise.resolve('first'),
      () => { throw new Error('respond blew up (e.g. non-cloneable payload)') },
      (err) => {
        onErrorCalls.push(err)
        throw new Error('onError blew up too')
      },
    )
    actor.run(
      () => Promise.resolve('second'),
      () => { secondRan = true },
    )

    // Let both queued .then/.catch links settle.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))

    // The failing onError was reported, and the chain kept resolving so the
    // subsequently queued job still executes (pre-fix it silently never ran).
    expect(onErrorCalls).toHaveLength(1)
    expect(secondRan).toBe(true)
  })
})

describe('dispatcher', () => {
  it('routes a solveAssembly message through the actor and posts its response', async () => {
    // Earlier tests leave solveAssembly rejecting; pin the happy path here so
    // the job under test resolves.
    vi.mocked(solveAssembly).mockResolvedValue({
      transforms: {}, bodies: {}, anchors: {}, anchorDescriptors: {},
      status: { verdict: 'none', residualNorm: 0, rank: 0, dof: 0, iters: 0, mates: {}, parts: {} },
    })
    const actor = new WorkerActor()
    const runSpy = vi.spyOn(actor, 'run')
    const posted: AssemblyWorkerResponse[] = []
    handleWorkerMessage(makeReq({ id: 5 }), (msg) => { posted.push(msg) }, actor)

    // The dispatcher hands the actor a job plus a respond callback.
    expect(runSpy).toHaveBeenCalledTimes(1)
    expect(typeof runSpy.mock.calls[0][0]).toBe('function')
    expect(typeof runSpy.mock.calls[0][1]).toBe('function')

    // Let the actor chain run the job; its response is posted once.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ id: 5, kind: 'solveAssembly', ok: true })
  })

  it('routes an asr_relayRes message to the pending relay request', async () => {
    const actor = new WorkerActor()
    const requests: AnchorRelayRequest[] = []
    const service = createRelayService((m) => requests.push(m))
    const prom = service.requestPartDoc('doc-a')
    const posted: AssemblyWorkerResponse[] = []
    handleWorkerMessage(
      { kind: 'asr_relayRes', requestId: requests[0].requestId, ok: true, payload: { kind: 'part' } },
      (msg) => { posted.push(msg) },
      actor,
    )
    // A relay response completes its pending promise directly; it is not a
    // solve, so it must not be queued on the actor or posted back.
    await expect(prom).resolves.toEqual({ kind: 'part' })
    expect(posted).toHaveLength(0)
  })

  it('routes a late buildBundle asr_relayRes through the salvage path', async () => {
    // The late-salvage branches were only driven through handleRelayResponse
    // directly; route one through handleWorkerMessage to pin the dispatcher
    // seam itself. A short real timeout keeps the test fast and avoids mixing
    // fake timers with the relay's grace timer.
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
    const requests: AnchorRelayRequest[] = []
    const relay = createRelayService((m) => requests.push(m), 10)
    const prom = relay.requestBuildBundle('doc-a', '1', {})
    await expect(prom).rejects.toThrow(/timed out/)

    const posted: AssemblyWorkerResponse[] = []
    handleWorkerMessage(
      { kind: 'asr_relayRes', requestId: requests[0].requestId, ok: true, payload: makeBundle('doc-a', '1') },
      (msg) => { posted.push(msg) },
      new WorkerActor(),
    )

    // The dispatcher handed the late reply to the salvage path, which caches
    // the finished build; it is not a solve, so nothing is posted.
    expect(posted).toHaveLength(0)
    await vi.waitUntil(async () => (await bundleCacheGet('doc-a', '1')) !== undefined)
  })

  it('replies with an error on an unknown message kind so the client settles', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const actor = new WorkerActor()
      const runSpy = vi.spyOn(actor, 'run')
      const posted: AssemblyWorkerResponse[] = []
      handleWorkerMessage(
        { id: 5, kind: 'futureKind', assemblyId: 'asm', parts: [], revs: {}, mates: [] } as unknown as AssemblyWorkerRequest,
        (msg) => { posted.push(msg) },
        actor,
      )
      expect(warnSpy).toHaveBeenCalledWith('[anchorSolverWorker] unknown message kind', 'futureKind')
      // No solve is queued, but the message still gets an error reply keyed to
      // its id and stamped with the solveAssembly discriminant, or the client
      // would drop the reply and hang the request.
      expect(runSpy).not.toHaveBeenCalled()
      expect(posted).toEqual([{
        id: 5,
        kind: 'solveAssembly',
        ok: false,
        error: 'unknown message kind: futureKind',
      }])
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('only warns on an unknown kind with no numeric id, since it names no slot to settle', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const actor = new WorkerActor()
      const runSpy = vi.spyOn(actor, 'run')
      const posted: AssemblyWorkerResponse[] = []
      handleWorkerMessage(
        { kind: 'futureKind', assemblyId: 'asm', parts: [], revs: {}, mates: [] } as unknown as AssemblyWorkerRequest,
        (msg) => { posted.push(msg) },
        actor,
      )
      expect(warnSpy).toHaveBeenCalledWith('[anchorSolverWorker] unknown message kind', 'futureKind')
      expect(runSpy).not.toHaveBeenCalled()
      expect(posted).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
