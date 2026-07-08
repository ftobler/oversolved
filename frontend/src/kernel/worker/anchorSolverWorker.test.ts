/**
 * Unit tests for the anchor solver worker handlers. The handlers are pure
 * async functions that take the relay service as a parameter, so tests
 * inject a fake relay — no real Worker, no WASM, no OCC.
 */

import { describe, it, expect } from 'vitest'
import {
  handleSolveAssembly,
  handleRelayResponse,
  createRelayService,
} from './anchorSolverWorker'
import type {
  SolveAssemblyRequest,
  AssemblySolveOkResponse,
  AnchorRelayRequest,
} from './solverProtocol'

function makeReq(overrides?: Partial<SolveAssemblyRequest>): SolveAssemblyRequest {
  return {
    id: 1,
    kind: 'solveAssembly',
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
    ...overrides,
  }
}

function fakeRelay(): { service: ReturnType<typeof createRelayService>; requests: AnchorRelayRequest[] } {
  const requests: AnchorRelayRequest[] = []
  const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
  return { service: createRelayService(post), requests }
}

describe('handleSolveAssembly', () => {
  it('echoes transforms for a mateless doc', async () => {
    const relay = fakeRelay()
    const res = await handleSolveAssembly(makeReq(), relay.service)
    expect(res.ok).toBe(true)
    const payload = (res as AssemblySolveOkResponse).payload
    expect(payload.transforms).toEqual({
      p1: { tx: 1, ty: 2, tz: 3, qx: 0, qy: 0, qz: 0, qw: 1 },
      p2: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    })
  })

  it('returns transforms for single-part assembly', async () => {
    const relay = fakeRelay()
    const req = makeReq({
      parts: [
        { handle: 'only', doc_id: 'd', doc_rev: 1, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0.5, qz: 0, qw: 0.866 } },
      ],
      revs: { 'd': 1 },
    })
    const res = await handleSolveAssembly(req, relay.service)
    expect(res.ok).toBe(true)
    const payload = (res as AssemblySolveOkResponse).payload
    expect(Object.keys(payload.transforms)).toEqual(['only'])
    expect(payload.transforms['only'].qy).toBeCloseTo(0.5)
  })

  it('echoes transforms without touching relay', async () => {
    const relay = fakeRelay()
    await handleSolveAssembly(makeReq(), relay.service)
    expect(relay.requests).toHaveLength(0)
  })

  it('returns error when handler throws', async () => {
    // Force an error by passing a malformed req that triggers a throw
    const relay = fakeRelay()
    const badReq = {
      id: 1,
      kind: 'solveAssembly',
      parts: null as unknown as SolveAssemblyRequest['parts'],
      revs: {},
    } as SolveAssemblyRequest
    const res = await handleSolveAssembly(badReq, relay.service)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBeTruthy()
    }
  })

  it('preserves request id in response', async () => {
    const relay = fakeRelay()
    const res = await handleSolveAssembly(makeReq({ id: 42 }), relay.service)
    expect(res.id).toBe(42)
  })
})

describe('relay plumbing', () => {
  it('relayRequest resolves when relay response arrives', async () => {
    const requests: AnchorRelayRequest[] = []
    const post = (msg: AnchorRelayRequest): void => { requests.push(msg) }
    const relay = createRelayService(post)

    // Start a relay request (don't await yet)
    const prom = relay.requestPartDoc('my-doc-id')

    // The request should have been posted
    expect(requests).toHaveLength(1)
    expect(requests[0].kind).toBe('asr_relay')
    expect(requests[0].subKind).toBe('partDocContent')
    expect(requests[0].doc_id).toBe('my-doc-id')

    // Simulate the main thread's response
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
})
