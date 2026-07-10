import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  solveViaWorker, exportViaWorker, exportAssemblyViaWorker,
  setSolverWorkerForTest, setSolverTimeoutForTest,
  type SolverWorkerLike,
} from './solverClient'
import type { SolveResponse, ExportResponse, BundleResponse, WorkerRequest } from './solverProtocol'

type AnyResponse = SolveResponse | ExportResponse | BundleResponse

// A controllable fake Worker: records posted requests and lets the test push
// responses (or an error) back on demand.
class FakeWorker implements SolverWorkerLike {
  onmessage: ((e: { data: AnyResponse }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  posted: WorkerRequest[] = []
  terminated = false

  postMessage(msg: WorkerRequest): void {
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
})
