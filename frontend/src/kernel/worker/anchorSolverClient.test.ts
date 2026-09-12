/**
 * Unit tests for the anchor solver client. Uses a FakeWorker (controllable
 * mock) injected via `setAnchorSolverWorkerForTest`. Tests cover solveAssembly
 * round-trips, relay plumbing, crash handling, and error paths.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  solveAssemblyViaWorker,
  setRelayHandlers,
  clearRelayHandlers,
  getRelayHandlers,
  setAnchorSolverWorkerForTest,
  setAnchorSolverTimeoutForTest,
  setAnchorSolverCrashBackoffForTest,
  cancelAssemblySolver,
  getPendingCount,
  relayReplyTransferables,
  BUNDLE_FRESH,
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
import { BUNDLE_SCHEMA, type PartBundle } from '../partBundle'

class FakeWorker implements AnchorSolverWorkerLike {
  onmessage: ((e: { data: AssemblyWorkerResponse }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  posted: AssemblyWorkerRequest[] = []
  // Parallel to `posted`: the transfer arg passed to each postMessage.
  transfers: (Transferable[] | undefined)[] = []
  // Fresh copies delivered across a transfer: a transferred message is never
  // the same object as the source - the source's buffers detach.
  received: AssemblyWorkerRequest[] = []
  terminated = false
  failOnPost = false
  // Throws only on a successful relay-reply post (ok:true), leaving the benign
  // ok:false fallback reply free to post. Mirrors a DataCloneError on the
  // relay-reply postMessage while keeping the catch's recovery observable.
  failOnRelayReplyPost = false

  postMessage(msg: AssemblyWorkerRequest, transfer?: Transferable[]): void {
    if (this.failOnPost) throw new Error('DataCloneError: the object could not be cloned')
    if (this.failOnRelayReplyPost && msg.kind === 'asr_relayRes' && (msg as { ok?: boolean }).ok) {
      throw new Error('DataCloneError: the object could not be cloned')
    }
    this.posted.push(msg)
    this.transfers.push(transfer)
    if (transfer && transfer.length > 0) {
      // structuredClone with a transfer list detaches the source buffers and
      // yields the receiver's fresh copy - the exact semantics of the real
      // `postMessage(..., transfer)` the client's relay post performs.
      this.received.push(structuredClone(msg, { transfer }) as AssemblyWorkerRequest)
    }
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

// Poll for a posted message of a given kind. The repo's vitest (3.2.4) resolves
// `vi.waitFor` immediately with any non-thenable return, so the callback must
// throw until the condition holds (a thenable return is what arms the polling).
async function waitForPosted(worker: FakeWorker, kind: string): Promise<void> {
  await vi.waitFor(async () => {
    if (worker.posted.some(m => m.kind === kind)) return true
    throw new Error(`expected a posted message of kind '${kind}'`)
  }, { timeout: 1000 })
}

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
      { handle: 'p1', doc_id: 'd1', transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
    ]
    const revs = { d1: '1' }

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
      payload: { transforms: { p1: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }, bodies: { p1: [] }, anchors: {} },
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

  it('rejects with a fallback diagnostic when an error response has no error field', async () => {
    const prom = solveAssemblyViaWorker('asm-1', [], {}, [])
    const req = fakeWorker.posted[0] as SolveAssemblyRequest

    fakeWorker.reply({ id: req.id, kind: 'solveAssembly', ok: false } as unknown as AssemblyWorkerResponse)
    await expect(prom).rejects.toThrow('worker returned an error response')
  })

  it('does not settle a pending solve on a future response kind with a colliding id', async () => {
    const prom = solveAssemblyViaWorker('asm-1', [], {}, [])
    const req = fakeWorker.posted[0] as SolveAssemblyRequest

    // A future response kind sharing the id must be ignored, not treated as a
    // solveAssembly response: the pending solve stays live.
    fakeWorker.reply({ id: req.id, kind: 'futureKind', ok: false, error: 'oops' } as unknown as AssemblyWorkerResponse)
    expect(getPendingCount()).toBe(1)

    fakeWorker.reply({
      id: req.id, kind: 'solveAssembly', ok: true,
      payload: { transforms: {}, bodies: {}, anchors: {} },
    })
    await expect(prom).resolves.not.toBeNull()
  })

  it('test reset rejects an in-flight request and drops late replies from the old worker', async () => {
    const prom = solveAssemblyViaWorker('asm-1', [], {}, [])
    const oldWorker = fakeWorker
    expect(getPendingCount()).toBe(1)

    const w2 = new FakeWorker()
    setAnchorSolverWorkerForTest(() => w2)
    await expect(prom).rejects.toThrow('worker reset by test')
    expect(getPendingCount()).toBe(0)

    // nextId restarts at 1, so the old worker's late reply (also id 1) would
    // settle the new worker's entry; the reset detaches the old onmessage so
    // only the respawned worker's own reply lands.
    const p2 = solveAssemblyViaWorker('asm-2', [], {}, [])
    const req2 = w2.posted[0] as SolveAssemblyRequest
    oldWorker.reply({
      id: req2.id, kind: 'solveAssembly', ok: true,
      payload: { transforms: { stale: { tx: 9, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }, bodies: {}, anchors: {} },
    })
    w2.reply({
      id: req2.id, kind: 'solveAssembly', ok: true,
      payload: { transforms: { fresh: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }, bodies: {}, anchors: {} },
    })
    const res = await p2
    expect(res?.payload.transforms).toEqual({ fresh: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } })
  })

  it('handles concurrent requests via single shared worker', async () => {
    const p1 = solveAssemblyViaWorker(
      'asm-1',
      [{ handle: 'a', doc_id: 'd1', transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { d1: '1' },
      [],
    )
    const p2 = solveAssemblyViaWorker(
      'asm-2',
      [{ handle: 'b', doc_id: 'd2', transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { d2: '2' },
      [],
    )

    const [r1, r2] = fakeWorker.posted as SolveAssemblyRequest[]
    fakeWorker.reply({ id: r1.id, kind: 'solveAssembly', ok: true, payload: { transforms: { a: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }, bodies: { a: [] }, anchors: {} } })
    fakeWorker.reply({ id: r2.id, kind: 'solveAssembly', ok: true, payload: { transforms: { b: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }, bodies: { b: [] }, anchors: {} } })

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

  it('rejects (not hangs) when postMessage throws, leaves pending empty, and the next solve still works', async () => {
    fakeWorker.failOnPost = true
    // A non-cloneable payload (or a worker that died mid-post) makes postMessage
    // throw; the promise must reject rather than hang, and no entry may leak.
    await expect(solveAssemblyViaWorker('asm-1', [], {}, [])).rejects.toThrow('DataCloneError')
    expect(getPendingCount()).toBe(0)
    fakeWorker.failOnPost = false
    const p = solveAssemblyViaWorker('asm-2', [], {}, [])
    const req = fakeWorker.posted[0] as SolveAssemblyRequest
    fakeWorker.reply({
      id: req.id, kind: 'solveAssembly', ok: true,
      payload: { transforms: {}, bodies: {}, anchors: {} },
    })
    const res = await p
    expect(res).not.toBeNull()
  })
})

  // Respawn assertions below swap `fakeWorker` for a fresh instance rather
  // than calling setAnchorSolverWorkerForTest: the reset would also clear a
  // crash-armed cooldown, masking exactly the state these tests exercise.
  function respawn(): FakeWorker {
    fakeWorker = new FakeWorker()
    return fakeWorker
  }

  async function settleNextSolve(worker: FakeWorker): Promise<void> {
    const p = solveAssemblyViaWorker('asm-respawn', [], {}, [])
    const req = worker.posted[0] as SolveAssemblyRequest
    worker.reply({
      id: req.id, kind: 'solveAssembly', ok: true,
      payload: { transforms: {}, bodies: {}, anchors: {} },
    })
    await expect(p).resolves.not.toBeNull()
  }

  it('rejects in-flight requests on a crash and respawns a fresh worker next solve', async () => {
    // A single crash with no burst (cooldown disabled here) must respawn on
    // the next solve exactly as before the cooldown existed. The burst case is
    // the crash-cooldown suite below.
    setAnchorSolverCrashBackoffForTest(0)
    const p = solveAssemblyViaWorker('asm-1', [], {}, [])
    fakeWorker.crash()
    await expect(p).rejects.toThrow('anchor solver worker crashed')
    expect(fakeWorker.terminated).toBe(true)
    // Next solve spawns a new worker (the crashed one was dropped).
    const w2 = respawn()
    await settleNextSolve(w2)
  })

  describe('crash cooldown', () => {
    afterEach(() => vi.useRealTimers())

    it('collapses a crash burst into one respawn: the rest backoff-reject', async () => {
      vi.useFakeTimers()
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])
      fakeWorker.crash()
      await expect(p).rejects.toThrow('anchor solver worker crashed')
      // Three immediate re-solves inside the window (the drag-tick shape over
      // a trapping doc): none may spawn a fresh worker, all reject with the
      // cooldown's own signal.
      await expect(solveAssemblyViaWorker('asm-2', [], {}, [])).rejects.toThrow('anchor solver worker crashed (backoff)')
      await expect(solveAssemblyViaWorker('asm-3', [], {}, [])).rejects.toThrow('anchor solver worker crashed (backoff)')
      await expect(solveAssemblyViaWorker('asm-4', [], {}, [])).rejects.toThrow('anchor solver worker crashed (backoff)')
      expect(getPendingCount()).toBe(0)
      // Only the original post exists: no request of the burst reached a
      // (re)spawned worker.
      expect(fakeWorker.posted).toHaveLength(1)
    })

    it('after the cooldown elapses the next solve respawns a fresh worker', async () => {
      vi.useFakeTimers()
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])
      fakeWorker.crash()
      await expect(p).rejects.toThrow('anchor solver worker crashed')
      vi.advanceTimersByTime(2001)  // past the 2000ms window
      const w2 = respawn()
      await settleNextSolve(w2)
    })

    it('a user cancel does not arm the cooldown', async () => {
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])
      cancelAssemblySolver()
      await expect(p).rejects.toThrow('assembly solve cancelled')
      expect(fakeWorker.terminated).toBe(true)
      // A cancel is user-initiated, not a trap: the next solve spawns at once.
      const w2 = respawn()
      await settleNextSolve(w2)
    })

    it('a watchdog timeout does not arm the cooldown', async () => {
      vi.useFakeTimers()
      setAnchorSolverTimeoutForTest(1000)
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])
      vi.advanceTimersByTime(1000)
      await expect(p).rejects.toThrow('anchor solver timed out')
      // The watchdog already spaced the drops, so the next solve respawns at
      // once instead of waiting out a cooldown.
      const w2 = respawn()
      await settleNextSolve(w2)
    })

    it('a user cancel clears a crash-armed cooldown so the next solve spawns at once', async () => {
      // The clear is defensive: a backoff rejection is synchronous, so while
      // the window is armed the overlay never paints a cancel button and no
      // live user cancel can land here. The clear still matches documented
      // intent (a deliberate drop lifts the cooldown), so pin that it works.
      vi.useFakeTimers()
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])
      fakeWorker.crash()
      await expect(p).rejects.toThrow('anchor solver worker crashed')
      await expect(solveAssemblyViaWorker('asm-2', [], {}, [])).rejects.toThrow('anchor solver worker crashed (backoff)')
      cancelAssemblySolver()
      const w2 = respawn()
      await settleNextSolve(w2)
    })

    it('setAnchorSolverCrashBackoffForTest overrides the window', async () => {
      vi.useFakeTimers()
      setAnchorSolverCrashBackoffForTest(500)
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])
      fakeWorker.crash()
      await expect(p).rejects.toThrow('anchor solver worker crashed')
      // Inside the shortened window: still backing off.
      vi.advanceTimersByTime(250)
      await expect(solveAssemblyViaWorker('asm-2', [], {}, [])).rejects.toThrow('anchor solver worker crashed (backoff)')
      // Past it: respawns normally.
      vi.advanceTimersByTime(251)
      const w2 = respawn()
      await settleNextSolve(w2)
    })
  })

  describe('hang watchdog and cancel', () => {
    afterEach(() => vi.useRealTimers())

    it('is disabled by default: a never-replying worker is never killed without arming', async () => {
      vi.useFakeTimers()
      // No setAnchorSolverTimeoutForTest: this is the production ceiling (Infinity).
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])
      vi.advanceTimersByTime(10 * 60 * 1000)
      expect(fakeWorker.terminated).toBe(false)
      // Still live: the request settles normally whenever the reply does arrive,
      // and only cancelAssemblySolver() can end it early.
      const req = fakeWorker.posted[0] as SolveAssemblyRequest
      fakeWorker.reply({
        id: req.id, kind: 'solveAssembly', ok: true,
        payload: { transforms: {}, bodies: {}, anchors: {} },
      })
      await expect(p).resolves.not.toBeNull()
    })

    it('terminates a hung worker and rejects the in-flight request when the watchdog fires', async () => {
      vi.useFakeTimers()
      setAnchorSolverTimeoutForTest(1000)
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])  // worker never replies
      vi.advanceTimersByTime(1000)
      await expect(p).rejects.toThrow('anchor solver timed out')
      expect(fakeWorker.terminated).toBe(true)
      expect(getPendingCount()).toBe(0)
      // Dropped worker respawns fresh on the next solve.
      const w2 = new FakeWorker()
      setAnchorSolverWorkerForTest(() => w2)
      const p2 = solveAssemblyViaWorker('asm-2', [], {}, [])
      const req2 = w2.posted[0] as SolveAssemblyRequest
      w2.reply({
        id: req2.id, kind: 'solveAssembly', ok: true,
        payload: { transforms: {}, bodies: {}, anchors: {} },
      })
      await expect(p2).resolves.not.toBeNull()
    })

    it('fails every in-flight request when one hangs (shared worker is killed)', async () => {
      vi.useFakeTimers()
      setAnchorSolverTimeoutForTest(1000)
      const p1 = solveAssemblyViaWorker('asm-1', [], {}, [])
      const p2 = solveAssemblyViaWorker('asm-2', [], {}, [])
      vi.advanceTimersByTime(1000)
      await expect(p1).rejects.toThrow('anchor solver timed out')
      await expect(p2).rejects.toThrow('anchor solver timed out')
      expect(getPendingCount()).toBe(0)
    })

    it('clears the watchdog on a normal reply so a settled request is never killed', async () => {
      vi.useFakeTimers()
      setAnchorSolverTimeoutForTest(1000)
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])
      const req = fakeWorker.posted[0] as SolveAssemblyRequest
      fakeWorker.reply({
        id: req.id, kind: 'solveAssembly', ok: true,
        payload: { transforms: {}, bodies: {}, anchors: {} },
      })
      await expect(p).resolves.not.toBeNull()
      vi.advanceTimersByTime(5000)  // past the ceiling: no spurious terminate
      expect(fakeWorker.terminated).toBe(false)
    })

    it('cancelAssemblySolver rejects the in-flight request with a benign cancel error', async () => {
      const p = solveAssemblyViaWorker('asm-1', [], {}, [])
      expect(getPendingCount()).toBe(1)
      cancelAssemblySolver()
      await expect(p).rejects.toThrow('assembly solve cancelled')
      expect(fakeWorker.terminated).toBe(true)
      expect(getPendingCount()).toBe(0)
    })
})

describe('relay plumbing', () => {
  // Helper: establish a worker connection (wires onmessage) then simulate the
  // worker sending a relay request through that channel.
  async function sendRelay(req: AnchorRelayRequest): Promise<void> {
    // establish connection by starting a solve (we don't care about its outcome)
    void solveAssemblyViaWorker(
      '_asm',
      [{ handle: '_', doc_id: '_', transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { _: '1' },
      [],
    ).catch(() => {})  // never settles here; the afterEach reset rejects it
    // onmessage is now wired; simulate a relay request from the worker
    fakeWorker.reply(req)
  }

  // A relayable PartBundle: each body mesh carries one ArrayBuffer per heavy
  // array, the exact buffers hop 2 must transfer instead of re-cloning.
  function makeBundle(): PartBundle {
    return {
      doc_id: 'bundle-doc',
      content_hash: 'h5',
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

  // Find the index of the relay reply post, mirroring the assertion helpers
  // the existing tests use to locate `asr_relayRes` messages.
  function relayReplyIndex(): number {
    return fakeWorker.posted.findIndex(m => m.kind === 'asr_relayRes')
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
      content_hash: 'h5',
      spec: { features: [] },
    })

    // waitForPosted throws until the reply lands: a bare boolean callback
    // resolves vi.waitFor immediately (repo quirk, see its docstring).
    await waitForPosted(fakeWorker, 'asr_relayRes')
    const relayRes = fakeWorker.posted.find(m => m.kind === 'asr_relayRes')
    expect(relayRes).toBeDefined()
    expect(handlers.buildBundle).toHaveBeenCalledWith('bundle-doc', 'h5', { features: [] })
  })

  it('relay response carries a protocol error when a buildBundle request is missing content_hash/spec', async () => {
    const handlers = {
      partDocContent: vi.fn(),
      buildBundle: vi.fn(),
    }
    setRelayHandlers(handlers)

    await sendRelay({
      kind: 'asr_relay',
      requestId: 204,
      subKind: 'buildBundle',
      doc_id: 'bundle-doc',
      // doc_rev and spec deliberately omitted: a malformed wire message.
    })

    await vi.waitFor(() => fakeWorker.posted.length > 1, { timeout: 1000 })
    const relayRes = fakeWorker.posted.find(m => m.kind === 'asr_relayRes') as AnchorRelayErrResponse | undefined
    expect(relayRes).toBeDefined()
    if (relayRes) {
      expect(relayRes.ok).toBe(false)
      expect(relayRes.error).toContain('missing content_hash/spec')
    }
    expect(handlers.buildBundle).not.toHaveBeenCalled()
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

  it('clearRelayHandlers unregisters so a later relay request posts an error response', async () => {
    setAnchorSolverWorkerForTest(() => fakeWorker)
    setRelayHandlers({
      partDocContent: vi.fn().mockResolvedValue({ kind: 'part' }),
      buildBundle: vi.fn(),
    })
    expect(getRelayHandlers()).not.toBeNull()

    clearRelayHandlers()
    expect(getRelayHandlers()).toBeNull()

    await sendRelay({
      kind: 'asr_relay',
      requestId: 808,
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

  it('drops a stale relay reply when the worker crashed and respawned before it resolved', async () => {
    const handlers = {
      partDocContent: vi.fn(),
      buildBundle: vi.fn(),
    }
    setRelayHandlers(handlers)

    // Keep the FIRST relay handler call pending so the crash + respawn happen
    // before it resolves; later calls (W2's own relay) resolve immediately.
    let resolveRelay!: (v: unknown) => void
    let relayCalls = 0
    handlers.partDocContent.mockImplementation(() => {
      relayCalls += 1
      if (relayCalls === 1) {
        return new Promise((res) => { resolveRelay = res })
      }
      return Promise.resolve({ kind: 'part', features: [] })
    })

    const part = { handle: 'p1', doc_id: 'd1', transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }
    const w1 = fakeWorker

    // W1 is wired by the solve, then sends a relay request.
    const solve1 = solveAssemblyViaWorker('asm-1', [part], { d1: '1' }, [])
    w1.reply({ kind: 'asr_relay', requestId: 1, subKind: 'partDocContent', doc_id: 'doc-x' })

    // W1 crashes mid-relay; its pending solve is rejected.
    w1.crash()
    await expect(solve1).rejects.toThrow('anchor solver worker crashed')
    expect(w1.terminated).toBe(true)

    // A new solve respawns W2 before the stale relay handler resolves.
    const w2 = new FakeWorker()
    setAnchorSolverWorkerForTest(() => w2)
    setRelayHandlers(handlers)
    void solveAssemblyViaWorker('asm-2', [part], { d1: '1' }, []).catch(() => {})  // never settles here; the reset rejects it
    expect(w2.posted).toHaveLength(1)

    // The stale relay finally resolves; its reply must go to the captured
    // sender (the terminated W1), never to the respawned W2.
    resolveRelay({ kind: 'part', features: [] })
    await waitForPosted(w1, 'asr_relayRes')
    expect(w2.posted.some(m => m.kind === 'asr_relayRes')).toBe(false)

    // W2's own relay still round-trips cleanly.
    w2.reply({ kind: 'asr_relay', requestId: 10, subKind: 'partDocContent', doc_id: 'doc-y' })
    await waitForPosted(w2, 'asr_relayRes')
    const w2res = w2.posted.find(m => m.kind === 'asr_relayRes') as AnchorRelayOkResponse | undefined
    expect(w2res).toBeDefined()
    if (w2res) {
      expect(w2res.requestId).toBe(10)
      expect(w2res.ok).toBe(true)
    }
  })

  it('regression: a normal in-flight relay (no crash) delivers to the same worker', async () => {
    setRelayHandlers({
      partDocContent: vi.fn().mockResolvedValue({ kind: 'part', features: [{ id: 'f1' }] }),
      buildBundle: vi.fn(),
    })

    void solveAssemblyViaWorker(
      '_asm',
      [{ handle: '_', doc_id: '_', transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { _: '1' },
      [],
    ).catch(() => {})  // never settles here; the afterEach reset rejects it
    fakeWorker.reply({ kind: 'asr_relay', requestId: 7, subKind: 'partDocContent', doc_id: 'doc' })

    await waitForPosted(fakeWorker, 'asr_relayRes')
    const res = fakeWorker.posted.find(m => m.kind === 'asr_relayRes') as AnchorRelayOkResponse | undefined
    expect(res).toBeDefined()
    if (res) {
      expect(res.requestId).toBe(7)
      expect(res.ok).toBe(true)
    }
  })

  it('a buildBundle relay reply transfers its mesh buffers (zero-copy) to the worker', async () => {
    const bundle = makeBundle()
    setRelayHandlers({
      partDocContent: vi.fn(),
      buildBundle: vi.fn().mockResolvedValue(bundle),
    })

    await sendRelay({
      kind: 'asr_relay',
      requestId: 501,
      subKind: 'buildBundle',
      doc_id: 'bundle-doc',
      content_hash: 'h5',
      spec: { features: [] },
    })

    await waitForPosted(fakeWorker, 'asr_relayRes')
    const idx = relayReplyIndex()
    expect(idx).toBeGreaterThanOrEqual(0)
    const transfer = fakeWorker.transfers[idx]
    expect(transfer).toBeDefined()
    const mesh = bundle.bodies[0].mesh
    expect(transfer).toContain(mesh.vertices.buffer)
    expect(transfer).toContain(mesh.indices.buffer)
    expect(transfer).toContain(mesh.faceIdsPerTriangle.buffer)
  })

  it('C1: a reference-only bundle spec never carries import bytes to the anchor worker', async () => {
    // The anchor worker holds references, not bytes. The spec it relays names a
    // file id, and every message the client posts to it must stay byte-free; the
    // OCC bundle worker receives the resolved bytes on the main thread instead.
    const bundle = makeBundle()
    setRelayHandlers({
      partDocContent: vi.fn(),
      buildBundle: vi.fn().mockResolvedValue(bundle),
    })
    const spec = { kind: 'part', features: [{ id: 'imp1', kind: 'import_step', file_id: 'file-1' }] }

    await sendRelay({
      kind: 'asr_relay',
      requestId: 778,
      subKind: 'buildBundle',
      doc_id: 'doc',
      content_hash: 'h1',
      spec,
    })
    await waitForPosted(fakeWorker, 'asr_relayRes')

    const hasBytes = (value: unknown): boolean => {
      if (value instanceof Uint8Array) return true
      if (Array.isArray(value)) return value.some(hasBytes)
      if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(hasBytes)
      return false
    }
    // The spec the worker sent stays reference-only, and nothing the client
    // posted back to it (or received as a transferred clone) carries bytes.
    expect(hasBytes(spec)).toBe(false)
    for (const msg of fakeWorker.posted) expect(hasBytes(msg)).toBe(false)
    for (const msg of fakeWorker.received) expect(hasBytes(msg)).toBe(false)
  })

  it('a partDocContent relay reply posts with no transfer list', async () => {
    setRelayHandlers({
      partDocContent: vi.fn().mockResolvedValue({ kind: 'part', features: [] }),
      buildBundle: vi.fn(),
    })

    await sendRelay({
      kind: 'asr_relay',
      requestId: 602,
      subKind: 'partDocContent',
      doc_id: 'doc',
    })

    await waitForPosted(fakeWorker, 'asr_relayRes')
    const idx = relayReplyIndex()
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(fakeWorker.transfers[idx]).toBeUndefined()
  })

  it('WK-L2: a relay-reply postMessage that throws answers ok:false instead of hanging', async () => {
    setRelayHandlers({
      partDocContent: vi.fn().mockResolvedValue({ kind: 'part', features: [] }),
      buildBundle: vi.fn(),
    })
    // A DataCloneError on the relay-reply post (e.g. a detached transfer buffer,
    // or a worker gone mid-post) must not leave the worker's pending relay
    // request unanswered: it answers with a minimal, always-cloneable ok:false
    // reply so the worker rejects now instead of spinning forever.
    fakeWorker.failOnRelayReplyPost = true

    void solveAssemblyViaWorker(
      '_asm',
      [{ handle: '_', doc_id: '_', transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
      { _: '1' },
      [],
    ).catch(() => {})  // never settles here; the afterEach reset rejects it
    fakeWorker.reply({ kind: 'asr_relay', requestId: 911, subKind: 'partDocContent', doc_id: 'doc' })

    await vi.waitFor(() => {
      const r = fakeWorker.posted.find(m => m.kind === 'asr_relayRes')
      if (r && !r.ok) return true
      throw new Error('expected an ok:false relay reply')
    }, { timeout: 1000 })

    const relayRes = fakeWorker.posted.find(m => m.kind === 'asr_relayRes') as AnchorRelayErrResponse
    expect(relayRes.requestId).toBe(911)
    expect(relayRes.ok).toBe(false)
    expect(relayRes.error).toContain('failed to post')
  })

  it('ownership: the relay transfer detaches the main-thread bundle buffers and delivers a fresh copy', async () => {
    const bundle = makeBundle()
    const verts = Array.from(bundle.bodies[0].mesh.vertices)
    const indices = Array.from(bundle.bodies[0].mesh.indices)
    setRelayHandlers({
      partDocContent: vi.fn(),
      buildBundle: vi.fn().mockResolvedValue(bundle),
    })

    await sendRelay({
      kind: 'asr_relay',
      requestId: 703,
      subKind: 'buildBundle',
      doc_id: 'bundle-doc',
      content_hash: 'h5',
      spec: { features: [] },
    })

    await waitForPosted(fakeWorker, 'asr_relayRes')
    // The relayed bundle is the main thread's only reference to these buffers:
    // after the transfer they are detached, and the relay handler must not
    // read them again (the contract is pinned here, not after the fact).
    const mesh = bundle.bodies[0].mesh
    expect(mesh.vertices.buffer.byteLength).toBe(0)
    expect(mesh.indices.buffer.byteLength).toBe(0)
    expect(mesh.faceIdsPerTriangle.buffer.byteLength).toBe(0)

    // The worker side received a fresh structured-clone copy with usable
    // buffers - what a real anchor worker's relay reply resolves to.
    await vi.waitFor(() => {
      if (fakeWorker.received.length > 0) return true
      throw new Error('expected the transferred relay reply to arrive')
    }, { timeout: 1000 })
    const copy = fakeWorker.received[fakeWorker.received.length - 1] as AnchorRelayOkResponse
    const copyBundle = copy.payload as PartBundle
    expect(Array.from(copyBundle.bodies[0].mesh.vertices)).toEqual(verts)
    expect(Array.from(copyBundle.bodies[0].mesh.indices)).toEqual(indices)
    expect(copyBundle.bodies[0].mesh.faceIdsPerTriangle.byteLength).toBeGreaterThan(0)
  })

  describe('BUNDLE_FRESH ownership stamp (review-17 L37)', () => {
    // The collector is exercised directly: end to end, setRelayHandlers stamps
    // everything its handlers resolve, so an unstamped bundle can only be
    // observed at this seam - which is the point of the gate.
    function okReply(payload: unknown): AnchorRelayOkResponse {
      return { kind: 'asr_relayRes', requestId: 1, ok: true, payload } as AnchorRelayOkResponse
    }

    it('a stamped bundle yields its mesh buffers for transfer', () => {
      const bundle = makeBundle()
      Object.defineProperty(bundle, BUNDLE_FRESH, { value: true })
      const transfer = relayReplyTransferables('buildBundle', okReply(bundle))
      const mesh = bundle.bodies[0].mesh
      expect(transfer).toContain(mesh.vertices.buffer)
      expect(transfer).toContain(mesh.indices.buffer)
      expect(transfer).toContain(mesh.faceIdsPerTriangle.buffer)
    })

    it('an unstamped but structurally valid bundle falls back to no transfer', () => {
      // No stamp: exactly what a cached or foreign bundle looks like. The
      // buffers must NOT be detached behind the holder's back.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(relayReplyTransferables('buildBundle', okReply(makeBundle()))).toEqual([])
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no freshness stamp'), expect.anything())
      } finally {
        warn.mockRestore()
      }
    })

    it('the stamp does not survive a structured clone and cannot be forged by one', () => {
      // Symbols are dropped across postMessage: a clone of a stamped bundle
      // arrives unstamped, so a recycled reply can never pass as fresh.
      const bundle = makeBundle()
      Object.defineProperty(bundle, BUNDLE_FRESH, { value: true })
      const clone = structuredClone(bundle) as PartBundle
      expect(relayReplyTransferables('buildBundle', okReply(clone))).toEqual([])
    })

    it('setRelayHandlers stamps what its buildBundle handler resolves', async () => {
      const bundle = makeBundle()
      setRelayHandlers({
        partDocContent: vi.fn(),
        buildBundle: vi.fn().mockResolvedValue(bundle),
      })
      await sendRelay({
        kind: 'asr_relay',
        requestId: 901,
        subKind: 'buildBundle',
        doc_id: 'bundle-doc',
        content_hash: 'h5',
        spec: { features: [] },
      })
      await waitForPosted(fakeWorker, 'asr_relayRes')
      // End-to-end proof of the stamped path: the reply went out with the
      // bundle's real buffers in the transfer list.
      const idx = relayReplyIndex()
      expect(fakeWorker.transfers[idx]).toContain(bundle.bodies[0].mesh.vertices.buffer)
      // And the stamp itself is on the payload, invisible to equality.
      expect((bundle as { [BUNDLE_FRESH]?: true })[BUNDLE_FRESH]).toBe(true)
    })

    it('non-bundle replies never transfer regardless of stamping', () => {
      const docPayload = { kind: 'part', features: [] }
      Object.defineProperty(docPayload, BUNDLE_FRESH, { value: true })  // even a wrongly marked one
      expect(relayReplyTransferables('partDocContent', okReply(docPayload))).toEqual([])
      expect(relayReplyTransferables('buildBundle', { kind: 'asr_relayRes', requestId: 1, ok: false, error: 'x' } as AnchorRelayErrResponse)).toEqual([])
    })
  })
})
