// The MCP kernel host: one kernel worker at a time, calls serialized, and a
// stall budget that kills a worker whose solve stops announcing features,
// answers the call with a timeout naming the last feature, and spawns a fresh
// worker for the next call (bug-fuse-hang D2). Driven by a fake worker so
// every timing is exact; the real worker and the stdio server are covered by
// the MCP stall case in cliSmoke.test.ts.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { createKernelHost, KernelTimeout, type KernelWorkerLike, type KernelHostMessage, type KernelRequest } from '../kernelHost'

class FakeKernelWorker implements KernelWorkerLike {
  posted: KernelRequest[] = []
  terminated = false
  private handlers: { message: Array<(m: KernelHostMessage) => void>; error: Array<(e: Error) => void>; exit: Array<(c: number) => void> } = { message: [], error: [], exit: [] }

  postMessage(msg: KernelRequest): void {
    this.posted.push(msg)
  }
  on(event: 'message' | 'error' | 'exit', cb: never): void {
    (this.handlers[event] as unknown[]).push(cb)
  }
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(1)
  }
  send(msg: KernelHostMessage): void {
    for (const cb of this.handlers.message) cb(msg)
  }
  exit(code: number): void {
    for (const cb of this.handlers.exit) cb(code)
  }
  last(): KernelRequest {
    return this.posted[this.posted.length - 1]
  }
}

function setup(budgetMs = 1000) {
  const created: FakeKernelWorker[] = []
  const host = createKernelHost({
    budgetMs,
    factory: () => {
      const w = new FakeKernelWorker()
      created.push(w)
      return w
    },
  })
  return { host, created }
}

afterEach(() => vi.useRealTimers())

describe('createKernelHost', () => {
  it('posts a call to the worker and resolves with its reply value', async () => {
    const { host, created } = setup()
    const p = host.call('measure', { doc: 1 })
    await vi.waitFor(() => expect(created[0]?.posted).toHaveLength(1))
    const req = created[0].last()
    expect(req).toMatchObject({ op: 'measure', args: { doc: 1 } })
    created[0].send({ kind: 'reply', id: req.id, ok: true, value: { ok: true, volume: 8 } })
    await expect(p).resolves.toEqual({ ok: true, volume: 8 })
  })

  it('rejects with the kernel side error, a KernelFault keeping its name', async () => {
    const { host, created } = setup()
    const p = host.call('run', {})
    await vi.waitFor(() => expect(created[0]?.posted).toHaveLength(1))
    created[0].send({ kind: 'reply', id: created[0].last().id, ok: false, error: { name: 'KernelFault', message: 'kernel trapped twice' } })
    await expect(p).rejects.toMatchObject({ name: 'KernelFault', message: 'kernel trapped twice' })
  })

  it('kills a stalled worker, names the last feature, and answers the next call on a fresh worker', async () => {
    vi.useFakeTimers()
    const { host, created } = setup(2000)
    const p = host.call('run', {})
    await vi.waitFor(() => expect(created[0]?.posted).toHaveLength(1))
    created[0].send({ kind: 'progress', featureId: 'sk2' })
    created[0].send({ kind: 'progress', featureId: 'ex2' })
    const settled = expect(p).rejects.toThrow('solve timed out after 2 s in feature ex2')
    await vi.advanceTimersByTimeAsync(2000)
    await settled
    await expect(p).rejects.toBeInstanceOf(KernelTimeout)
    expect(created[0].terminated).toBe(true)

    const next = host.call('measure', {})
    await vi.waitFor(() => expect(created).toHaveLength(2))
    await vi.waitFor(() => expect(created[1].posted).toHaveLength(1))
    created[1].send({ kind: 'reply', id: created[1].last().id, ok: true, value: { ok: true } })
    await expect(next).resolves.toEqual({ ok: true })
  })

  it('bounds the gap between marks, not the call: steady progress never times out', async () => {
    vi.useFakeTimers()
    const { host, created } = setup(1000)
    const p = host.call('run', {})
    await vi.waitFor(() => expect(created[0]?.posted).toHaveLength(1))
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(900)
      created[0].send({ kind: 'progress', featureId: `f${i}` })
    }
    expect(created[0].terminated).toBe(false)
    created[0].send({ kind: 'reply', id: created[0].last().id, ok: true, value: 'done' })
    await expect(p).resolves.toBe('done')
  })

  it('a stall before any mark times out without a feature name', async () => {
    vi.useFakeTimers()
    const { host } = setup(1000)
    const p = host.call('run', {})
    const settled = expect(p).rejects.toThrow(/^solve timed out after 1 s$/)
    await vi.advanceTimersByTimeAsync(1000)
    await settled
  })

  it('serializes calls: the second is not posted until the first answers', async () => {
    const { host, created } = setup()
    const p1 = host.call('run', { n: 1 })
    const p2 = host.call('run', { n: 2 })
    await vi.waitFor(() => expect(created[0]?.posted).toHaveLength(1))
    expect(created[0].posted).toHaveLength(1)
    created[0].send({ kind: 'reply', id: created[0].last().id, ok: true, value: 1 })
    await expect(p1).resolves.toBe(1)
    await vi.waitFor(() => expect(created[0].posted).toHaveLength(2))
    created[0].send({ kind: 'reply', id: created[0].last().id, ok: true, value: 2 })
    await expect(p2).resolves.toBe(2)
    expect(created).toHaveLength(1)
  })

  it('a worker that exits mid-call fails that call and the next call respawns', async () => {
    const { host, created } = setup()
    const p = host.call('run', {})
    await vi.waitFor(() => expect(created[0]?.posted).toHaveLength(1))
    created[0].exit(7)
    await expect(p).rejects.toThrow('kernel worker exited with code 7')
    const next = host.call('run', {})
    await vi.waitFor(() => expect(created).toHaveLength(2))
    await vi.waitFor(() => expect(created[1].posted).toHaveLength(1))
    created[1].send({ kind: 'reply', id: created[1].last().id, ok: true, value: 'ok' })
    await expect(next).resolves.toBe('ok')
  })

  it('refuses a call after dispose instead of respawning a worker', async () => {
    const { host, created } = setup()
    await host.dispose()
    await expect(host.call('run', {})).rejects.toThrow('kernel host disposed')
    expect(created).toHaveLength(0)
  })

  it('reports a synchronous spawn failure as a lost worker', async () => {
    const host = createKernelHost({ budgetMs: 1000, factory: () => { throw new Error('no such module') } })
    await expect(host.call('run', {})).rejects.toMatchObject({
      name: 'KernelWorkerLost',
      message: 'kernel worker failed to start: no such module',
    })
  })
})
