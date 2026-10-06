import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync } from 'node:fs'
import {
  solveWithTimeout, disposeWorker, setSolveChildForTest, resetSolveChildForTest,
  runnerPath, loaderPath,
} from '../solveTimeout'

class FakeChild {
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  posted: Array<{ id: number; spec: Record<string, unknown>; options?: Record<string, unknown> }> = []
  killed = false

  send(msg: Record<string, unknown>): void {
    this.posted.push(msg as { id: number; spec: Record<string, unknown>; options?: Record<string, unknown> })
  }
  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
  }
  kill(_signal?: NodeJS.Signals): void {
    this.killed = true
  }
  emitMessage(msg: unknown): void {
    this.listeners.get('message')?.forEach((cb) => cb(msg))
  }
  emitError(e: Error): void {
    this.listeners.get('error')?.forEach((cb) => cb(e))
  }
  emitExit(code: number): void {
    this.listeners.get('exit')?.forEach((cb) => cb(code))
  }
}

function installFake(): FakeChild {
  const f = new FakeChild()
  setSolveChildForTest(() => f as unknown as import('../solveTimeout').SolveChildLike)
  return f
}

beforeEach(() => {
  // Each test creates its own fake via installFake().
  // Ensure no stale child from a previous test hangs around.
  vi.useRealTimers()
  resetSolveChildForTest()
})

afterEach(() => {
  vi.useRealTimers()
  try { disposeWorker() } catch {  /* ok */ }
  resetSolveChildForTest()
})

describe('solveWithTimeout', () => {
  it('posts a solve request and resolves with the result on reply', async () => {
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' })
    expect(f.posted).toHaveLength(1)
    const msg = f.posted[0]
    expect(msg.spec).toEqual({ id: 'd' })
    f.emitMessage({ id: msg.id, ok: true, result: { solve_ms: 2, result: { r: 1 }, bodies: {}, _build_state: { feature_order: [], checkpoints: {} } } })
    const res = await p
    expect(res).toEqual({ solve_ms: 2, result: { r: 1 }, bodies: {}, _build_state: { feature_order: [], checkpoints: {} } })
  })

  it('resolves null when the runner returns a null result', async () => {
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' })
    f.emitMessage({ id: f.posted[0].id, ok: true, result: null })
    await expect(p).resolves.toBeNull()
  })

  it('rejects when the runner returns an error response', async () => {
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' })
    f.emitMessage({ id: f.posted[0].id, ok: false, error: 'OCC unavailable' })
    await expect(p).rejects.toThrow('OCC unavailable')
  })

  it('rejects with a generic message when the error response carries none', async () => {
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' })
    f.emitMessage({ id: f.posted[0].id, ok: false })
    await expect(p).rejects.toThrow('solve failed')
  })

  it('ignores a late reply for an id that already settled', async () => {
    // A killed child can still flush its final message. An id no longer in the
    // pending map must be dropped, not routed to a new request.
    vi.useFakeTimers()
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' }, undefined, 1000)
    const staleId = f.posted[0].id
    vi.advanceTimersByTime(1000)
    await expect(p).rejects.toThrow('solve timed out after 1000ms')
    expect(() => f.emitMessage({ id: staleId, ok: true, result: null })).not.toThrow()
  })

  it('passes options through to the runner', async () => {
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' }, { rollbackPosition: 3 })
    expect(f.posted[0].options).toEqual({ rollbackPosition: 3 })
    f.emitMessage({ id: f.posted[0].id, ok: true, result: null })
    await p
  })
})

describe('solveWithTimeout crash handling', () => {
  it('rejects an in-flight solve on a child crash', async () => {
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' })
    f.emitError(new Error('boom'))
    await expect(p).rejects.toThrow('solve child process crashed')
    expect(f.killed).toBe(true)
  })

  it('respawns a fresh child after a crash', async () => {
    const f1 = installFake()
    const p1 = solveWithTimeout({ id: 'd' })
    f1.emitError(new Error('boom'))
    await expect(p1).rejects.toThrow('solve child process crashed')

    const f2 = installFake()
    const p2 = solveWithTimeout({ id: 'e' })
    expect(f2.posted).toHaveLength(1)
    f2.emitMessage({ id: f2.posted[0].id, ok: true, result: null })
    await expect(p2).resolves.toBeNull()
  })

  it('rejects in-flight solves on an unexpected exit', async () => {
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' })
    f.emitExit(1)
    await expect(p).rejects.toThrow('solve child exited with code 1')
  })

  it('ignores a late exit or error from a killed child once a replacement is pooled', async () => {
    vi.useFakeTimers()
    const f1 = installFake()
    const p1 = solveWithTimeout({ id: 'd' }, undefined, 1000)
    vi.advanceTimersByTime(1000)
    await expect(p1).rejects.toThrow('solve timed out after 1000ms')
    expect(f1.killed).toBe(true)

    const f2 = installFake()
    const p2 = solveWithTimeout({ id: 'e' })
    // The SIGKILL exit of the timed-out child arrives after f2 is pooled.
    f1.emitExit(null as unknown as number)
    f1.emitError(new Error('late crash'))
    expect(f2.killed).toBe(false)

    f2.emitMessage({ id: f2.posted[0].id, ok: true, result: null })
    await expect(p2).resolves.toBeNull()
  })
})

describe('solveWithTimeout hang watchdog', () => {
  it('kills a hung child and rejects the in-flight request', async () => {
    vi.useFakeTimers()
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' }, undefined, 1000)
    vi.advanceTimersByTime(1000)
    await expect(p).rejects.toThrow('solve timed out after 1000ms')
    expect(f.killed).toBe(true)
  })

  it('fails every in-flight request when one hangs (shared child is killed)', async () => {
    vi.useFakeTimers()
    const f = installFake()
    const p1 = solveWithTimeout({ id: 'a' }, undefined, 1000)
    const p2 = solveWithTimeout({ id: 'b' }, { rollbackPosition: 0 }, 1000)
    vi.advanceTimersByTime(1000)
    await expect(p1).rejects.toThrow('solve timed out after 1000ms')
    await expect(p2).rejects.toThrow('solve timed out after 1000ms')
    expect(f.killed).toBe(true)
  })

  it('clears the watchdog on a normal reply so a settled request is never killed', async () => {
    vi.useFakeTimers()
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' }, undefined, 1000)
    f.emitMessage({ id: f.posted[0].id, ok: true, result: null })
    await expect(p).resolves.toBeNull()
    vi.advanceTimersByTime(5000)
    expect(f.killed).toBe(false)
  })

  it('respawns a fresh child after a timeout kill', async () => {
    vi.useFakeTimers()
    const f1 = installFake()
    const p1 = solveWithTimeout({ id: 'd' }, undefined, 1000)
    vi.advanceTimersByTime(1000)
    await expect(p1).rejects.toThrow('solve timed out after 1000ms')
    expect(f1.killed).toBe(true)

    const f2 = installFake()
    const p2 = solveWithTimeout({ id: 'e' }, undefined, 1000)
    expect(f2.posted).toHaveLength(1)
    f2.emitMessage({ id: f2.posted[0].id, ok: true, result: null })
    await expect(p2).resolves.toBeNull()
  })
})

describe('disposeWorker', () => {
  it('rejects in-flight requests and kills the child', async () => {
    vi.useFakeTimers()
    const f = installFake()
    const p = solveWithTimeout({ id: 'd' }, undefined, 999999)
    disposeWorker()
    await expect(p).rejects.toThrow('disposed')
    expect(f.killed).toBe(true)
  })
})

describe('forked child wiring', () => {
  it('runner and loader paths point at the real files the fork needs', () => {
    // A rename of either file silently breaks every direct solve; the paths
    // are computed from import.meta.url, so assert they land on real files.
    expect(existsSync(runnerPath())).toBe(true)
    expect(existsSync(loaderPath())).toBe(true)
  })

  it('re-injecting a factory while a child is live tears the old child down', async () => {
    const f1 = installFake()
    const abandoned = solveWithTimeout({ id: 'd' }, undefined, 999999)
    const f2 = new FakeChild()
    setSolveChildForTest(() => f2 as unknown as import('../solveTimeout').SolveChildLike)
    expect(f1.killed).toBe(true)
    // The new factory drives the next request; the abandoned one never settles.
    const p2 = solveWithTimeout({ id: 'e' })
    expect(f2.posted).toHaveLength(1)
    f2.emitMessage({ id: f2.posted[0].id, ok: true, result: null })
    await expect(p2).resolves.toBeNull()
    void abandoned
  })
})
