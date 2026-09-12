import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  solveViaWorker, exportViaWorker, exportAssemblyViaWorker, buildBundleViaWorker,
  setSolverWorkerForTest, setSolverTimeoutForTest, setSolverCrashBackoffForTest,
  cancelSolver, getPendingCount,
  EMPTY_BUILD_STATE,
  type SolverWorkerLike,
} from './solverClient'
import { fileIdsMissingFromWorker, dropWorkerFileId } from './workerFiles'
import type { SolveResponse, ExportResponse, BundleResponse, WorkerRequest } from './solverProtocol'
import type { BuildState } from '../types3d'

type AnyResponse = SolveResponse | ExportResponse | BundleResponse

// A controllable fake Worker: records posted requests and lets the test push
// responses (or an error) back on demand.
class FakeWorker implements SolverWorkerLike {
  onmessage: ((e: { data: AnyResponse }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  posted: WorkerRequest[] = []
  terminated = false
  failOnPost = false
  // Total bytes carried in `files` across every posted request. A counter, not a
  // tautology: a transfer-once regression makes this exceed the payload size.
  byteCrossings = 0

  postMessage(msg: WorkerRequest): void {
    if (this.failOnPost) throw new Error('DataCloneError: the object could not be cloned')
    for (const bytes of Object.values(msg.files ?? {})) this.byteCrossings += bytes.byteLength
    this.posted.push(msg)
  }
  terminate(): void {
    this.terminated = true
  }
  reply(res: AnyResponse): void {
    this.onmessage?.({ data: res })
  }
  crash(): void {
    this.onerror?.(new Error('boom'))
  }
}

let fake: FakeWorker
let created: FakeWorker[]

beforeEach(() => {
  created = []
  setSolverWorkerForTest(() => {
    fake = new FakeWorker()
    created.push(fake)
    return fake
  })
})

afterEach(() => setSolverWorkerForTest(null))

describe('solveViaWorker', () => {
  it('correlates a response by id and fills a placeholder _build_state', async () => {
    const p = solveViaWorker({ id: 'd' }, { rollbackPosition: 1 })
    expect(fake.posted).toHaveLength(1)
    const { id } = fake.posted[0]
    fake.reply({ id, ok: true, payload: { solve_ms: 2, result: { r: 1 }, bodies: {} } })
    const res = await p
    expect(res).toEqual({ solve_ms: 2, result: { r: 1 }, bodies: {}, _build_state: { feature_order: [], checkpoints: {} } })
  })

  it('deep-freezes the placeholder that fills _build_state, nesting included', () => {
    expect(Object.isFrozen(EMPTY_BUILD_STATE)).toBe(true)
    expect(Object.isFrozen(EMPTY_BUILD_STATE.feature_order)).toBe(true)
    expect(Object.isFrozen(EMPTY_BUILD_STATE.checkpoints)).toBe(true)
  })

  it('a mutation attempt on the shared placeholder throws and leaves it empty across solves', async () => {
    const p1 = solveViaWorker({ id: 'd' })
    fake.reply({ id: fake.posted[0].id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
    const res1 = await p1
    expect(res1).not.toBeNull()
    // A consumer that bypasses the readonly type (a plain push) must hit the
    // deep freeze at runtime rather than corrupt the shared placeholder.
    const featureOrder = (res1!._build_state as BuildState).feature_order
    expect(() => featureOrder.push('f1')).toThrow(TypeError)
    expect(featureOrder).toHaveLength(0)

    const p2 = solveViaWorker({ id: 'e' })
    fake.reply({ id: fake.posted[1].id, ok: true, payload: { solve_ms: 2, result: {}, bodies: {} } })
    const res2 = await p2
    expect(res2).not.toBeNull()
    expect(res2!._build_state.feature_order).toHaveLength(0)
  })

  it('resolves null when the engine reported OCC unavailable (null payload)', async () => {
    const p = solveViaWorker({ id: 'd' })
    fake.reply({ id: fake.posted[0].id, ok: true, payload: null })
    await expect(p).resolves.toBeNull()
  })

  it('rejects when the worker returns an error response', async () => {
    const p = solveViaWorker({ id: 'd' })
    fake.reply({ id: fake.posted[0].id, ok: false, error: 'kernel boom' })
    await expect(p).rejects.toThrow('kernel boom')
  })

  it('rejects with a fallback diagnostic when an error response has no error field', async () => {
    const p = solveViaWorker({ id: 'd' })
    fake.reply({ id: fake.posted[0].id, ok: false } as unknown as AnyResponse)
    await expect(p).rejects.toThrow('worker returned an error response')
  })

  it('test reset rejects an in-flight request and drops late replies from the old worker', async () => {
    // Left in flight across the reset, like a promise a beforeEach reset must
    // not leave dangling.
    const p = solveViaWorker({ id: 'd' })
    const oldWorker = fake
    expect(getPendingCount()).toBe(1)

    setSolverWorkerForTest(() => {
      fake = new FakeWorker()
      created.push(fake)
      return fake
    })
    await expect(p).rejects.toThrow('worker reset by test')
    expect(getPendingCount()).toBe(0)

    // nextId restarts at 1, so the old worker's late reply (also id 1) would
    // settle the new worker's entry; the reset detaches the old onmessage so
    // only the respawned worker's own reply lands.
    const p2 = solveViaWorker({ id: 'e' })
    const req2 = fake.posted[0]
    oldWorker.reply({ id: req2.id, ok: true, payload: { solve_ms: 9, result: { stale: true }, bodies: {} } })
    fake.reply({ id: req2.id, ok: true, payload: { solve_ms: 0, result: { fresh: true }, bodies: {} } })
    expect((await p2)?.result).toEqual({ fresh: true })
  })

  it('correlates concurrent requests independently and reuses one worker', async () => {
    const p1 = solveViaWorker({ id: 'a' })
    const p2 = solveViaWorker({ id: 'b' })
    expect(created).toHaveLength(1)  // single dedicated worker
    const [r1, r2] = fake.posted
    expect(r1.id).not.toBe(r2.id)
    // Reply out of order; each promise must get its own payload.
    fake.reply({ id: r2.id, ok: true, payload: { solve_ms: 1, result: { which: 'b' }, bodies: {} } })
    fake.reply({ id: r1.id, ok: true, payload: { solve_ms: 1, result: { which: 'a' }, bodies: {} } })
    expect((await p1)!.result).toEqual({ which: 'a' })
    expect((await p2)!.result).toEqual({ which: 'b' })
  })

  it('resolves null when no worker can be created', async () => {
    setSolverWorkerForTest(() => null)
    await expect(solveViaWorker({ id: 'd' })).resolves.toBeNull()
  })

  describe('exportViaWorker', () => {
    it('posts an export request and resolves the returned bytes', async () => {
      const p = exportViaWorker({ id: 'd' }, { format: 'step' })
      expect(fake.posted).toHaveLength(1)
      const req = fake.posted[0]
      expect(req.kind).toBe('export')
      const bytes = new Uint8Array([1, 2, 3])
      fake.reply({ id: req.id, ok: true, bytes })
      await expect(p).resolves.toBe(bytes)
    })

    it('resolves null when the engine produced no body (null bytes)', async () => {
      const p = exportViaWorker({ id: 'd' }, { format: 'stl' })
      fake.reply({ id: fake.posted[0].id, ok: true, bytes: null })
      await expect(p).resolves.toBeNull()
    })

    it('rejects on an error response', async () => {
      const p = exportViaWorker({ id: 'd' }, { format: 'step', bodyId: 'x' })
      fake.reply({ id: fake.posted[0].id, ok: false, error: "body 'x' not found" })
      await expect(p).rejects.toThrow('not found')
    })

    it('routes solve and export replies to their own callers on a shared worker', async () => {
      const solveP = solveViaWorker({ id: 's' })
      const exportP = exportViaWorker({ id: 'e' }, { format: 'step' })
      expect(created).toHaveLength(1)  // shared worker, distinct id space
      const solveReq = fake.posted[0]
      const exportReq = fake.posted[1]
      expect(solveReq.id).not.toBe(exportReq.id)
      const bytes = new Uint8Array([9])
      fake.reply({ id: exportReq.id, ok: true, bytes })
      fake.reply({ id: solveReq.id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
      await expect(exportP).resolves.toBe(bytes)
      await expect(solveP).resolves.not.toBeNull()
    })

    it('rejects in-flight exports on a worker crash', async () => {
      const p = exportViaWorker({ id: 'd' }, { format: 'step' })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
    })
  })

  describe('exportAssemblyViaWorker', () => {
    const PLACED = { tx: 5, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

    it('posts an exportAssembly request carrying every placed part', async () => {
      const parts = [{ spec: { id: 'a' }, transform: PLACED }, { spec: { id: 'b' }, transform: PLACED }]
      const p = exportAssemblyViaWorker(parts, { format: 'step' })
      const req = fake.posted[0]
      expect(req.kind).toBe('exportAssembly')
      expect(req).toMatchObject({ parts, options: { format: 'step' } })
      const bytes = new Uint8Array([7])
      fake.reply({ id: req.id, ok: true, bytes })
      await expect(p).resolves.toBe(bytes)
    })

    it('resolves null when no part produced a solid', async () => {
      const p = exportAssemblyViaWorker([], { format: 'step' })
      fake.reply({ id: fake.posted[0].id, ok: true, bytes: null })
      await expect(p).resolves.toBeNull()
    })

    it('shares the id space with solve, so a reply reaches its own caller', async () => {
      const solveP = solveViaWorker({ id: 's' })
      const exportP = exportAssemblyViaWorker([{ spec: { id: 'a' }, transform: PLACED }], { format: 'stl' })
      expect(created).toHaveLength(1)
      const [solveReq, exportReq] = fake.posted
      expect(solveReq.id).not.toBe(exportReq.id)
      const bytes = new Uint8Array([3])
      fake.reply({ id: exportReq.id, ok: true, bytes })
      fake.reply({ id: solveReq.id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
      await expect(exportP).resolves.toBe(bytes)
      await expect(solveP).resolves.not.toBeNull()
    })

    it('rejects on an error response', async () => {
      const p = exportAssemblyViaWorker([{ spec: {}, transform: PLACED }], { format: 'step' })
      fake.reply({ id: fake.posted[0].id, ok: false, error: 'STEP export: Write failed' })
      await expect(p).rejects.toThrow('Write failed')
    })
  })

  describe('hang watchdog', () => {
    afterEach(() => vi.useRealTimers())

    it('is disabled by default: a solve that never replies is never killed', async () => {
      vi.useFakeTimers()
      // No setSolverTimeoutForTest: this is the production ceiling (Infinity).
      const p = solveViaWorker({ id: 'd' })  // worker never replies
      vi.advanceTimersByTime(10 * 60 * 1000)
      expect(created[0].terminated).toBe(false)
      // Still live: the request settles normally whenever the reply does arrive,
      // and only cancelSolver() can end it early.
      created[0].reply({ id: created[0].posted[0].id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
      await expect(p).resolves.not.toBeNull()
    })

    it('terminates a hung worker and rejects the in-flight request when the watchdog fires', async () => {
      vi.useFakeTimers()
      setSolverTimeoutForTest(1000)
      const p = solveViaWorker({ id: 'd' })  // worker never replies
      vi.advanceTimersByTime(1000)
      await expect(p).rejects.toThrow('solver worker timed out')
      expect(created[0].terminated).toBe(true)
      // Dropped worker respawns fresh on the next solve, rebuilding from feature 0.
      const p2 = solveViaWorker({ id: 'e' })
      expect(created).toHaveLength(2)
      created[1].reply({ id: created[1].posted[0].id, ok: true, payload: { solve_ms: 0, result: {}, bodies: {} } })
      await expect(p2).resolves.not.toBeNull()
    })

    it('fails every in-flight request when one hangs (shared worker is killed)', async () => {
      vi.useFakeTimers()
      setSolverTimeoutForTest(1000)
      const p1 = solveViaWorker({ id: 'a' })
      const p2 = exportViaWorker({ id: 'b' }, { format: 'step' })
      vi.advanceTimersByTime(1000)
      await expect(p1).rejects.toThrow('solver worker timed out')
      await expect(p2).rejects.toThrow('solver worker timed out')
    })

    it('clears the watchdog on a normal reply so a settled request is never killed', async () => {
      vi.useFakeTimers()
      setSolverTimeoutForTest(1000)
      const p = solveViaWorker({ id: 'd' })
      fake.reply({ id: fake.posted[0].id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
      await expect(p).resolves.not.toBeNull()
      vi.advanceTimersByTime(5000)  // past the ceiling: no spurious terminate
      expect(created[0].terminated).toBe(false)
    })
  })

  it('rejects in-flight solves on a worker crash and respawns a fresh worker next solve', async () => {
    // A single crash with no burst (cooldown disabled here) must respawn on the
    // next solve exactly as before the cooldown existed. The burst case is the
    // crash-cooldown suite below.
    setSolverCrashBackoffForTest(0)
    const p = solveViaWorker({ id: 'd' })
    fake.crash()
    await expect(p).rejects.toThrow('solver worker crashed')
    expect(created[0].terminated).toBe(true)
    // Next solve spawns a new worker (the crashed one was dropped).
    const p2 = solveViaWorker({ id: 'e' })
    expect(created).toHaveLength(2)
    created[1].reply({ id: created[1].posted[0].id, ok: true, payload: { solve_ms: 0, result: {}, bodies: {} } })
    await expect(p2).resolves.not.toBeNull()
  })

  describe('crash cooldown', () => {
    afterEach(() => vi.useRealTimers())

    it('collapses a crash burst into one respawn: the rest backoff-reject', async () => {
      vi.useFakeTimers()
      const p = solveViaWorker({ id: 'd' })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
      // Three immediate reSolves inside the window: none may spawn a fresh
      // Worker, all reject with the cooldown's own signal.
      const p2 = solveViaWorker({ id: 'e' })
      const p3 = solveViaWorker({ id: 'f' })
      const p4 = solveViaWorker({ id: 'g' })
      await expect(p2).rejects.toThrow('solver worker crashed (backoff)')
      await expect(p3).rejects.toThrow('solver worker crashed (backoff)')
      await expect(p4).rejects.toThrow('solver worker crashed (backoff)')
      expect(created).toHaveLength(1)
      expect(getPendingCount()).toBe(0)
    })

    it('after the cooldown elapses the next solve respawns a fresh worker', async () => {
      vi.useFakeTimers()
      const p = solveViaWorker({ id: 'd' })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
      vi.advanceTimersByTime(2001)  // past the 2000ms window
      const p2 = solveViaWorker({ id: 'e' })
      expect(created).toHaveLength(2)
      created[1].reply({ id: created[1].posted[0].id, ok: true, payload: { solve_ms: 0, result: {}, bodies: {} } })
      await expect(p2).resolves.not.toBeNull()
    })

    it('a user cancel does not arm the cooldown', async () => {
      const p = solveViaWorker({ id: 'd' })
      cancelSolver()
      await expect(p).rejects.toThrow('solve cancelled')
      expect(created[0].terminated).toBe(true)
      // A cancel is user-initiated, not a trap: the next solve spawns at once.
      const p2 = solveViaWorker({ id: 'e' })
      expect(created).toHaveLength(2)
      created[1].reply({ id: created[1].posted[0].id, ok: true, payload: { solve_ms: 0, result: {}, bodies: {} } })
      await expect(p2).resolves.not.toBeNull()
    })

    it('a watchdog timeout does not arm the cooldown', async () => {
      vi.useFakeTimers()
      setSolverTimeoutForTest(1000)
      const p = solveViaWorker({ id: 'd' })
      vi.advanceTimersByTime(1000)
      await expect(p).rejects.toThrow('solver worker timed out')
      // The watchdog already spaced the drops, so the next solve respawns at
      // once instead of waiting out a cooldown.
      const p2 = solveViaWorker({ id: 'e' })
      expect(created).toHaveLength(2)
      created[1].reply({ id: created[1].posted[0].id, ok: true, payload: { solve_ms: 0, result: {}, bodies: {} } })
      await expect(p2).resolves.not.toBeNull()
    })

    it('a user cancel clears a crash-armed cooldown so the next solve spawns at once', async () => {
      // The clear is defensive: a backoff rejection is synchronous, so while
      // the window is armed the overlay never paints a cancel button and no
      // live user cancel can land here. The clear still matches documented
      // intent (a deliberate drop lifts the cooldown), so pin that it works.
      vi.useFakeTimers()
      const p = solveViaWorker({ id: 'd' })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
      await expect(solveViaWorker({ id: 'e' })).rejects.toThrow('solver worker crashed (backoff)')
      cancelSolver()
      const p2 = solveViaWorker({ id: 'f' })
      expect(created).toHaveLength(2)
      created[1].reply({ id: created[1].posted[0].id, ok: true, payload: { solve_ms: 0, result: {}, bodies: {} } })
      await expect(p2).resolves.not.toBeNull()
    })

    it('carves export out of the cooldown: an export proceeds at once while a solve still backoff-rejects', async () => {
      vi.useFakeTimers()
      const p = solveViaWorker({ id: 'd' })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
      // The cooldown is about a drag burst over a trapping doc; a solve inside
      // the window still rides it...
      await expect(solveViaWorker({ id: 'e' })).rejects.toThrow('solver worker crashed (backoff)')
      // ...but an export is a deliberate single action, so it spawns a fresh
      // worker immediately instead of waiting out the window.
      const p2 = exportViaWorker({ id: 'f' }, { format: 'step' })
      expect(created).toHaveLength(2)
      const bytes = new Uint8Array([5, 6])
      created[1].reply({ id: created[1].posted[0].id, ok: true, bytes })
      await expect(p2).resolves.toBe(bytes)
    })

    it('carves exportAssembly out of the cooldown too', async () => {
      vi.useFakeTimers()
      const p = solveViaWorker({ id: 'd' })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
      await expect(solveViaWorker({ id: 'e' })).rejects.toThrow('solver worker crashed (backoff)')
      // exportAssembly is a deliberate single click like export: it spawns a
      // fresh worker immediately instead of waiting out the window.
      const assemblyP = exportAssemblyViaWorker(
        [{ spec: { id: 'a' }, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }],
        { format: 'step' },
      )
      expect(created).toHaveLength(2)
      const bytes = new Uint8Array([9])
      created[1].reply({ id: created[1].posted[0].id, ok: true, bytes })
      await expect(assemblyP).resolves.toBe(bytes)
    })

    it('a buildBundle burst rides the crash cooldown: inside the window the relay backoff-rejects', async () => {
      // buildBundle is relayed per solveAssembly (useAssemblySolve wires it as
      // the anchor worker's buildBundle handler), so a drag tick over a trapping
      // part doc fires it in a burst like solve. It must collapse to one respawn
      // instead of spawning a fresh trapping OCC worker per tick.
      vi.useFakeTimers()
      const p = solveViaWorker({ id: 'd' })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
      const b1 = buildBundleViaWorker({ id: 'e' }, 'doc1', '1')
      const b2 = buildBundleViaWorker({ id: 'f' }, 'doc1', '1')
      const b3 = buildBundleViaWorker({ id: 'g' }, 'doc1', '1')
      await expect(b1).rejects.toThrow('solver worker crashed (backoff)')
      await expect(b2).rejects.toThrow('solver worker crashed (backoff)')
      await expect(b3).rejects.toThrow('solver worker crashed (backoff)')
      expect(created).toHaveLength(1)
      expect(getPendingCount()).toBe(0)
    })

    it('the watchdog cannot fire inside the window after a crash, so onTimeout clearing is defensive', async () => {
      // Reachability: both the onTimeout and cancelSolver clears are defensive.
      // A crash's dropWorker clears every pending watchdog timer, so no onTimeout
      // can fire inside the window (and production never arms the watchdog at
      // all); a backoff rejection is synchronous, so the overlay never paints a
      // cancel button while the window is armed. The clears stay because they
      // match documented intent. This test pins that a crashed burst still
      // backoff-rejects even when advanced past the watchdog ceiling.
      vi.useFakeTimers()
      setSolverTimeoutForTest(1000)
      const p = solveViaWorker({ id: 'd' })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
      vi.advanceTimersByTime(1000)
      await expect(solveViaWorker({ id: 'e' })).rejects.toThrow('solver worker crashed (backoff)')
      expect(created).toHaveLength(1)
      expect(getPendingCount()).toBe(0)
    })

    it('setSolverCrashBackoffForTest overrides the window', async () => {
      vi.useFakeTimers()
      setSolverCrashBackoffForTest(500)
      const p = solveViaWorker({ id: 'd' })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
      // Inside the shortened window: still backing off.
      vi.advanceTimersByTime(250)
      await expect(solveViaWorker({ id: 'e' })).rejects.toThrow('solver worker crashed (backoff)')
      // Past it: respawns normally.
      vi.advanceTimersByTime(500)
      const p2 = solveViaWorker({ id: 'f' })
      expect(created).toHaveLength(2)
      created[1].reply({ id: created[1].posted[0].id, ok: true, payload: { solve_ms: 0, result: {}, bodies: {} } })
      await expect(p2).resolves.not.toBeNull()
    })
  })

  describe('import file transfer-once', () => {
    const F1 = new Uint8Array([1, 2, 3])

    it('puts files on the wire for all four request shapes', () => {
      solveViaWorker({ id: 's' }, {}, { f1: F1 })
      exportViaWorker({ id: 'e' }, { format: 'step' }, { f2: F1 })
      exportAssemblyViaWorker([{ spec: { id: 'a' }, transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } }], { format: 'step' }, { f3: F1 })
      buildBundleViaWorker({ id: 'b' }, 'doc', '1', { f4: F1 })
      const [solve, exp, asm, bundle] = fake.posted
      expect(solve.files).toEqual({ f1: F1 })
      expect(exp.files).toEqual({ f2: F1 })
      expect(asm.files).toEqual({ f3: F1 })
      expect(bundle.files).toEqual({ f4: F1 })
      for (const req of fake.posted) fake.reply({ id: req.id, ok: true, bytes: null, payload: null } as unknown as AnyResponse)
    })

    it('counts the bytes crossing exactly once across N requests in one generation', async () => {
      for (let i = 0; i < 5; i++) solveViaWorker({ id: 'd' }, {}, { f1: F1 })
      expect(fake.byteCrossings).toBe(F1.byteLength)
      // Only the first request carried the map; the rest sent files: undefined.
      expect(fake.posted[0].files).toEqual({ f1: F1 })
      for (const req of fake.posted.slice(1)) expect(req.files).toBeUndefined()
      for (const req of fake.posted) {
        fake.reply({ id: req.id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
      }
      await Promise.resolve()
    })

    it('does not resend an id an export already carried on the same generation', async () => {
      exportViaWorker({ id: 'e' }, { format: 'step' }, { f1: F1 })
      solveViaWorker({ id: 's' }, {}, { f1: F1 })
      expect(fake.posted[0].files).toEqual({ f1: F1 })
      expect(fake.posted[1].files).toBeUndefined()
      for (const req of fake.posted) fake.reply({ id: req.id, ok: true, bytes: null, payload: null } as unknown as AnyResponse)
      await Promise.resolve()
    })

    it('resends every id after a worker respawn', async () => {
      setSolverCrashBackoffForTest(0)
      const p = solveViaWorker({ id: 'd' }, {}, { f1: F1 })
      expect(fake.posted[0].files).toEqual({ f1: F1 })
      fake.crash()
      await expect(p).rejects.toThrow('solver worker crashed')
      solveViaWorker({ id: 'e' }, {}, { f1: F1 })
      const resent = fake.posted[fake.posted.length - 1]
      expect(resent.files).toEqual({ f1: F1 })
      fake.reply({ id: resent.id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
      await Promise.resolve()
    })

    it('does not mark ids sent when postMessage throws, so a retry still carries them', async () => {
      // Warm the worker connection and mark the first request's bytes as sent.
      const p1 = exportViaWorker({ id: 'e' }, { format: 'step' }, { f1: F1 })
      expect(fake.posted[0].files).toEqual({ f1: F1 })
      fake.reply({ id: fake.posted[0].id, ok: true, bytes: null })
      await p1
      expect(fileIdsMissingFromWorker(['f1'])).toEqual([])

      // A request whose post throws must NOT commit its ids: the worker never
      // received them, so a retry in the same generation has to send them again.
      fake.failOnPost = true
      const p2 = exportViaWorker({ id: 'e' }, { format: 'step' }, { f1: F1 })
      await expect(p2).rejects.toThrow('DataCloneError')
      expect(fileIdsMissingFromWorker(['f1'])).toEqual([])  // f1 was already sent by p1

      // A NEW id on the throwing request stays unmarked.
      const p3 = exportViaWorker({ id: 'e' }, { format: 'step' }, { f2: F1 })
      await expect(p3).rejects.toThrow('DataCloneError')
      expect(fileIdsMissingFromWorker(['f2'])).toEqual(['f2'])

      // The retry carries it, and only then is it marked.
      fake.failOnPost = false
      const p4 = exportViaWorker({ id: 'e' }, { format: 'step' }, { f2: F1 })
      const retry = fake.posted[fake.posted.length - 1]
      expect(retry.files).toEqual({ f2: F1 })
      expect(fileIdsMissingFromWorker(['f2'])).toEqual([])
      fake.reply({ id: retry.id, ok: true, bytes: null })
      await p4
    })

    it('reports ids the live generation already holds as no longer missing', async () => {
      expect(fileIdsMissingFromWorker(['f1'])).toEqual(['f1'])
      solveViaWorker({ id: 'd' }, {}, { f1: F1 })
      expect(fileIdsMissingFromWorker(['f1'])).toEqual([])
      fake.reply({ id: fake.posted[0].id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
      await Promise.resolve()
    })

    it('drops a single id so a replaced file is re-read by the next request', async () => {
      solveViaWorker({ id: 'd' }, {}, { f1: F1 })
      expect(fileIdsMissingFromWorker(['f1'])).toEqual([])
      dropWorkerFileId('f1')
      expect(fileIdsMissingFromWorker(['f1'])).toEqual(['f1'])
      fake.reply({ id: fake.posted[0].id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
      await Promise.resolve()
    })
  })

  describe('postMessage throw guard', () => {
    it('rejects (not hangs) when postMessage throws, leaves pending empty, and the next solve still works', async () => {
      // Wire the worker first (the factory assigns `fake` lazily on first use),
      // then arm the throw.
      const warmup = solveViaWorker({ id: 'warm' })
      fake.reply({ id: fake.posted[0].id, ok: true, payload: { solve_ms: 0, result: {}, bodies: {} } })
      await warmup
      fake.failOnPost = true
      // A non-cloneable spec (or a worker that died mid-post) makes postMessage
      // throw; the promise must reject rather than hang, and no entry may leak.
      await expect(solveViaWorker({ id: 'd' })).rejects.toThrow('DataCloneError')
      expect(getPendingCount()).toBe(0)
      fake.failOnPost = false
      const p = solveViaWorker({ id: 'e' })
      fake.reply({ id: fake.posted[1].id, ok: true, payload: { solve_ms: 1, result: {}, bodies: {} } })
      await expect(p).resolves.not.toBeNull()
    })

    it('regression: the normal reply path still resolves exactly once', async () => {
      const p = solveViaWorker({ id: 'd' })
      fake.reply({ id: fake.posted[0].id, ok: true, payload: { solve_ms: 1, result: { r: 1 }, bodies: {} } })
      await expect(p).resolves.toEqual({
        solve_ms: 1, result: { r: 1 }, bodies: {},
        _build_state: { feature_order: [], checkpoints: {} },
      })
      expect(getPendingCount()).toBe(0)
      // A duplicate reply for the settled id is a no-op (the entry is gone), and
      // a fresh solve still round-trips on the same worker.
      fake.reply({ id: fake.posted[0].id, ok: true, payload: { solve_ms: 9, result: {}, bodies: {} } })
      const p2 = solveViaWorker({ id: 'f' })
      fake.reply({ id: fake.posted[1].id, ok: true, payload: { solve_ms: 2, result: { r: 2 }, bodies: {} } })
      await expect(p2).resolves.not.toBeNull()
    })
  })
})
