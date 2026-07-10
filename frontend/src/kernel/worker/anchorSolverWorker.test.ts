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
