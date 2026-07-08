/**
 * Unit tests for the anchor solver client. Uses a FakeWorker (controllable
 * mock) injected via `setAnchorSolverWorkerForTest`. Tests cover solveAssembly
 * round-trips, relay plumbing, crash handling, and error paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  solveAssemblyViaWorker,
  setRelayHandlers,
  setAnchorSolverWorkerForTest,
} from './anchorSolverClient'
import type {
  AnchorSolverWorkerLike,
} from './anchorSolverClient'
import type {
  SolveAssemblyRequest,
  AssemblyWorkerRequest,
  AssemblyWorkerResponse,
  AnchorRelayRequest,
  AnchorRelayOkResponse,
  AnchorRelayErrResponse,
} from './solverProtocol'

class FakeWorker implements AnchorSolverWorkerLike {
  onmessage: ((e: { data: AssemblyWorkerResponse }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  posted: AssemblyWorkerRequest[] = []
  terminated = false

  postMessage(msg: AssemblyWorkerRequest): void {
    this.posted.push(msg)
  }

  terminate(): void {
    this.terminated = true
  }

  reply(res: AssemblyWorkerResponse): void {
    this.onmessage?.({ data: res })
  }

  crash(): void {
    this.onerror?.(new Error('boom'))
  }
}

let fakeWorker: FakeWorker

beforeEach(() => {
  fakeWorker = new FakeWorker()
  setAnchorSolverWorkerForTest(() => fakeWorker)
  setRelayHandlers({
    partDocContent: vi.fn().mockResolvedValue({ kind: 'part', features: [] }),
    buildBundle: vi.fn().mockResolvedValue({}),
  })
})

afterEach(() => {
  setAnchorSolverWorkerForTest(null)
})

describe('solveAssemblyViaWorker', () => {
  it('round-trips a mateless assembly and returns echoed transforms', async () => {
    const parts = [
      { handle: 'p1', doc_id: 'd1', doc_rev: 1, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
    ]
    const revs = { d1: 1 }

    const resultPromise = solveAssemblyViaWorker('asm-1', parts, revs, [])

    expect(fakeWorker.posted).toHaveLength(1)
    const req = fakeWorker.posted[0] as SolveAssemblyRequest
    expect(req.kind).toBe('solveAssembly')
    expect(req.assemblyId).toBe('asm-1')
    expect(req.parts).toEqual(parts)
    expect(req.mates).toEqual([])

    // Simulate worker response
    fakeWorker.reply({
      id: req.id, kind: 'solveAssembly', ok: true,
      payload: { transforms: { p1: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }, bodies: { p1: [] }, mateResults: {} },
    })

    const result = await resultPromise
    expect(result).not.toBeNull()
    expect(result!.ok).toBe(true)
    expect(result!.payload.transforms).toEqual({
      p1: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    })
  })

  it('resolves null when no worker factory is available', async () => {
    setAnchorSolverWorkerForTest(() => null)
    const result = await solveAssemblyViaWorker('asm-1', [], {}, [])
    expect(result).toBeNull()
  })

  it('rejects when worker returns error', async () => {
    const prom = solveAssemblyViaWorker('asm-1', [], {}, [])
    const req = fakeWorker.posted[0] as SolveAssemblyRequest

    fakeWorker.reply({ id: req.id, kind: 'solveAssembly', ok: false, error: 'mate solver not loaded' })
    await expect(prom).rejects.toThrow('mate solver not loaded')
  })

  it('handles concurrent requests via single shared worker', async () => {
    const p1 = solveAssemblyViaWorker(
      'asm-1',
      [{ handle: 'a', doc_id: 'd1', doc_rev: 1, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { d1: 1 },
      [],
    )
    const p2 = solveAssemblyViaWorker(
      'asm-2',
      [{ handle: 'b', doc_id: 'd2', doc_rev: 2, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { d2: 2 },
      [],
    )

    const [r1, r2] = fakeWorker.posted as SolveAssemblyRequest[]
    fakeWorker.reply({ id: r1.id, kind: 'solveAssembly', ok: true, payload: { transforms: { a: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }, bodies: { a: [] }, mateResults: {} } })
    fakeWorker.reply({ id: r2.id, kind: 'solveAssembly', ok: true, payload: { transforms: { b: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }, bodies: { b: [] }, mateResults: {} } })

    const [v1, v2] = await Promise.all([p1, p2])
    expect(v1?.payload.transforms).toHaveProperty('a')
    expect(v2?.payload.transforms).toHaveProperty('b')
  })

  it('rejects all in-flight requests and resets on worker crash', async () => {
    const p1 = solveAssemblyViaWorker('asm-1', [], {}, [])
    const p2 = solveAssemblyViaWorker('asm-1', [], {}, [])

    fakeWorker.crash()

    await expect(p1).rejects.toThrow('anchor solver worker crashed')
    await expect(p2).rejects.toThrow('anchor solver worker crashed')
    expect(fakeWorker.terminated).toBe(true)
  })
})

describe('relay plumbing', () => {
  // Helper: establish a worker connection (wires onmessage) then simulate the
  // worker sending a relay request through that channel.
  async function sendRelay(req: AnchorRelayRequest): Promise<void> {
    // establish connection by starting a solve (we don't care about its outcome)
    solveAssemblyViaWorker(
      '_asm',
      [{ handle: '_', doc_id: '_', doc_rev: 1, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { _: 1 },
      [],
    )
    // onmessage is now wired; simulate a relay request from the worker
    fakeWorker.reply(req)
  }

  it('handles a partDocContent relay request and posts response back', async () => {
    const handlers = {
      partDocContent: vi.fn().mockResolvedValue({ kind: 'part', features: [{ id: 'f1' }] }),
      buildBundle: vi.fn(),
    }
    setRelayHandlers(handlers)

    await sendRelay({
      kind: 'asr_relay',
      requestId: 101,
      subKind: 'partDocContent',
      doc_id: 'target-doc',
    })

    // The client should post a relay response back
    await vi.waitFor(() => fakeWorker.posted.length > 1, { timeout: 1000 })
    const relayRes = fakeWorker.posted.find(m => m.kind === 'asr_relayRes') as AnchorRelayOkResponse | undefined
    expect(relayRes).toBeDefined()
    expect(handlers.partDocContent).toHaveBeenCalledWith('target-doc')
    if (relayRes) {
      expect(relayRes.ok).toBe(true)
      expect(relayRes.payload).toEqual({ kind: 'part', features: [{ id: 'f1' }] })
    }
  })

  it('handles a buildBundle relay request', async () => {
    const handlers = {
      partDocContent: vi.fn(),
      buildBundle: vi.fn().mockResolvedValue({ bodies: [], anchors: {} }),
    }
    setRelayHandlers(handlers)

    await sendRelay({
      kind: 'asr_relay',
      requestId: 202,
      subKind: 'buildBundle',
      doc_id: 'bundle-doc',
      doc_rev: 5,
      spec: { features: [] },
    })

    await vi.waitFor(() => fakeWorker.posted.length > 1, { timeout: 1000 })
    const relayRes = fakeWorker.posted.find(m => m.kind === 'asr_relayRes')
    expect(relayRes).toBeDefined()
    expect(handlers.buildBundle).toHaveBeenCalledWith('bundle-doc', 5, { features: [] })
  })

  it('relay response carries error when handler throws', async () => {
    setRelayHandlers({
      partDocContent: vi.fn().mockRejectedValue(new Error('store unreachable')),
      buildBundle: vi.fn(),
    })

    await sendRelay({
      kind: 'asr_relay',
      requestId: 303,
      subKind: 'partDocContent',
      doc_id: 'missing',
    })

    await vi.waitFor(() => fakeWorker.posted.length > 1, { timeout: 1000 })
    const relayRes = fakeWorker.posted.find(m => m.kind === 'asr_relayRes') as AnchorRelayErrResponse | undefined
    expect(relayRes).toBeDefined()
    if (relayRes) {
      expect(relayRes.ok).toBe(false)
      expect(relayRes.error).toContain('store unreachable')
    }
  })

  it('relay response carries error when no handlers registered', async () => {
    // Start fresh with no handlers
    setAnchorSolverWorkerForTest(() => fakeWorker)

    await sendRelay({
      kind: 'asr_relay',
      requestId: 404,
      subKind: 'partDocContent',
      doc_id: 'doc',
    })

    await vi.waitFor(() => fakeWorker.posted.length > 1, { timeout: 1000 })
    const relayRes = fakeWorker.posted.find(m => m.kind === 'asr_relayRes') as AnchorRelayErrResponse | undefined
    expect(relayRes).toBeDefined()
    if (relayRes) {
      expect(relayRes.ok).toBe(false)
      expect(relayRes.error).toContain('no relay handlers')
    }
  })
})
