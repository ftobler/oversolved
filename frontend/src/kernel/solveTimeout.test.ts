import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  solveWithTimeout, setSolveWorkerForTest, disposeWorker,
  type SolveWorkerLike,
} from './solveTimeout'

interface PostedMsg {
  id: number
  spec: Record<string, unknown>
  options?: Record<string, unknown>
}

class FakeWorker implements SolveWorkerLike {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  onexit: ((code: number) => void) | null = null
  posted: PostedMsg[] = []
  terminated = false

  postMessage(msg: unknown): void {
    this.posted.push(msg as PostedMsg)
  }
  terminate(): void {
    this.terminated = true
  }
  reply(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, ok: true, result } })
  }
  replyError(id: number, error: string): void {
    this.onmessage?.({ data: { id, ok: false, error } })
  }
  crash(): void {
    this.onerror?.(new Error('boom'))
  }
}

let fake: FakeWorker
let created: FakeWorker[]

beforeEach(() => {
  created = []
  setSolveWorkerForTest(() => {
    fake = new FakeWorker()
    created.push(fake)
    return fake
  })
})

afterEach(() => {
  vi.useRealTimers()
  setSolveWorkerForTest(null)
})

describe('solveWithTimeout', () => {
  it('posts a solve request and resolves with the result on reply', async () => {
    const p = solveWithTimeout({ id: 'd' })
    expect(fake.posted).toHaveLength(1)
    const msg = fake.posted[0]
    expect(msg.spec).toEqual({ id: 'd' })
    fake.reply(msg.id, { solve_ms: 2, result: { r: 1 }, bodies: {}, _build_state: { feature_order: [], checkpoints: {} } })
    const res = await p
    expect(res).toEqual({ solve_ms: 2, result: { r: 1 }, bodies: {}, _build_state: { feature_order: [], checkpoints: {} } })
  })

  it('resolves null when the worker returns a null result', async () => {
    const p = solveWithTimeout({ id: 'd' })
    fake.reply(fake.posted[0].id, null)
    await expect(p).resolves.toBeNull()
  })

  it('rejects when the worker returns an error response', async () => {
    const p = solveWithTimeout({ id: 'd' })
    fake.replyError(fake.posted[0].id, 'OCC unavailable')
    await expect(p).rejects.toThrow('OCC unavailable')
  })

  it('passes options through to the worker', async () => {
    const p = solveWithTimeout({ id: 'd' }, { rollbackPosition: 3 })
    expect(fake.posted[0].options).toEqual({ rollbackPosition: 3 })
    fake.reply(fake.posted[0].id, null)
    await p
  })

  it('rejects when the worker factory returns null (no Worker API)', async () => {
    setSolveWorkerForTest(() => null)
    await expect(solveWithTimeout({ id: 'd' })).rejects.toThrow('worker_threads unavailable')
  })
})

describe('solveWithTimeout crash handling', () => {
  it('rejects an in-flight solve on a worker crash', async () => {
    const p = solveWithTimeout({ id: 'd' })
    fake.crash()
    await expect(p).rejects.toThrow('solve worker crashed')
  })

  it('respawns a fresh worker after a crash', async () => {
    const p1 = solveWithTimeout({ id: 'd' })
    fake.crash()
    await expect(p1).rejects.toThrow('solve worker crashed')
    expect(created[0].terminated).toBe(true)

    const p2 = solveWithTimeout({ id: 'e' })
    expect(created).toHaveLength(2)
    fake = created[1]!
    fake.reply(fake.posted[0].id, null)
    await expect(p2).resolves.toBeNull()
  })
})

describe('solveWithTimeout hang watchdog', () => {
  afterEach(() => vi.useRealTimers())

  it('terminates a hung worker and rejects the in-flight request', async () => {
    vi.useFakeTimers()
    const p = solveWithTimeout({ id: 'd' }, undefined, 1000)  // worker never replies
    vi.advanceTimersByTime(1000)
    await expect(p).rejects.toThrow('solve timed out after 1000ms')
    expect(created[0].terminated).toBe(true)
  })

  it('fails every in-flight request when one hangs (shared worker is killed)', async () => {
    vi.useFakeTimers()
    const p1 = solveWithTimeout({ id: 'a' }, undefined, 1000)
    const p2 = solveWithTimeout({ id: 'b' }, { rollbackPosition: 0 }, 1000)
    vi.advanceTimersByTime(1000)
    await expect(p1).rejects.toThrow('solve timed out after 1000ms')
    await expect(p2).rejects.toThrow('solve timed out after 1000ms')
  })

  it('clears the watchdog on a normal reply so a settled request is never killed', async () => {
    vi.useFakeTimers()
    const p = solveWithTimeout({ id: 'd' }, undefined, 1000)
    fake.reply(fake.posted[0].id, null)
    await expect(p).resolves.toBeNull()
    vi.advanceTimersByTime(5000)  // past the ceiling: no spurious terminate
    expect(created[0].terminated).toBe(false)
  })

  it('respawns a fresh worker after a timeout kill', async () => {
    vi.useFakeTimers()
    const p1 = solveWithTimeout({ id: 'd' }, undefined, 1000)
    vi.advanceTimersByTime(1000)
    await expect(p1).rejects.toThrow('solve timed out after 1000ms')
    expect(created[0].terminated).toBe(true)

    const p2 = solveWithTimeout({ id: 'e' }, undefined, 1000)
    expect(created).toHaveLength(2)
    fake = created[1]!
    fake.reply(fake.posted[0].id, null)
    await expect(p2).resolves.toBeNull()
  })
})

describe('disposeWorker', () => {
  it('rejects in-flight requests and terminates the worker', async () => {
    vi.useFakeTimers()
    const p = solveWithTimeout({ id: 'd' }, undefined, 999999)
    disposeWorker()
    await expect(p).rejects.toThrow('disposed')
    expect(created[0].terminated).toBe(true)
  })
})
