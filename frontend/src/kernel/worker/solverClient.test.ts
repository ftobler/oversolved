import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  solveViaWorker, exportViaWorker, exportAssemblyViaWorker,
  setSolverWorkerForTest, setSolverTimeoutForTest, getPendingCount,
  EMPTY_BUILD_STATE,
  type SolverWorkerLike,
} from './solverClient'
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

  postMessage(msg: WorkerRequest): void {
    if (this.failOnPost) throw new Error('DataCloneError: the object could not be cloned')
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
