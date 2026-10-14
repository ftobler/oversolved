// @vitest-environment node
// The worker-backed SolveScheduler's contract, pinned directly rather than
// through usePartDoc: request shaping, generation, supersession, idle and the
// error state. The adapter's equivalence with the session's scheduler suite is
// what lets DocSession tests trust the fake.
import { describe, it, expect, vi } from 'vitest'
import { createWorkerSolveScheduler, type ReSolveFn } from '@/hooks/workerSolveScheduler'
import type { PartDoc } from '@/types/cad'

const doc = (id: string): PartDoc =>
  ({ version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] })

describe('createWorkerSolveScheduler', () => {
  it('calls reSolve with just the doc when no options are given', async () => {
    const reSolve = vi.fn()
    const scheduler = createWorkerSolveScheduler(() => reSolve)

    await expect(scheduler.request(doc('a'))).resolves.toEqual({ generation: 1, status: 'applied' })
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect(reSolve).toHaveBeenCalledWith(doc('a'))
  })

  it('passes the solve options through when given', async () => {
    const reSolve = vi.fn()
    const scheduler = createWorkerSolveScheduler(() => reSolve)

    await scheduler.request(doc('a'), { bypassCache: true, _suppressFirstSolve: true })

    expect(reSolve).toHaveBeenCalledWith(doc('a'), { bypassCache: true, _suppressFirstSolve: true })
  })

  it('applies without calling when the solver ref has not landed yet', async () => {
    const scheduler = createWorkerSolveScheduler(() => null)

    await expect(scheduler.request(doc('a'))).resolves.toEqual({ generation: 1, status: 'applied' })
  })

  it('advances the generation and drops a stale outcome that settles after a newer one', async () => {
    const pending: Array<() => void> = []
    const reSolve: ReSolveFn = vi.fn(() => new Promise<void>(resolve => { pending.push(resolve) }))
    const scheduler = createWorkerSolveScheduler(() => reSolve)

    const first = scheduler.request(doc('a'))
    const second = scheduler.request(doc('b'), { bypassCache: true })
    expect(scheduler.state()).toEqual({ generation: 2, pending: true, running: true, lastError: null })

    // The newer request settles first and is adopted.
    pending[1]()
    await expect(second).resolves.toEqual({ generation: 2, status: 'applied' })

    // The stale one settles after and is dropped, never mistaken for current.
    pending[0]()
    await expect(first).resolves.toEqual({ generation: 1, status: 'superseded' })
    expect(scheduler.state().pending).toBe(false)
  })

  it('reports a thrown solve as an error outcome and keeps it as lastError', async () => {
    const reSolve = vi.fn(() => { throw new Error('worker crashed') })
    const scheduler = createWorkerSolveScheduler(() => reSolve)

    await expect(scheduler.request(doc('a'))).resolves.toEqual({
      generation: 1, status: 'error', error: 'worker crashed',
    })
    expect(scheduler.state().lastError).toBe('worker crashed')
  })

  it('a new request clears the previous error', async () => {
    let reSolve: ReSolveFn | null = () => { throw new Error('boom') }
    const scheduler = createWorkerSolveScheduler(() => reSolve)

    await scheduler.request(doc('a'))
    expect(scheduler.state().lastError).toBe('boom')

    reSolve = vi.fn()
    await scheduler.request(doc('b'))
    expect(scheduler.state().lastError).toBeNull()
  })

  it('idle resolves immediately with nothing pending', async () => {
    const scheduler = createWorkerSolveScheduler(() => vi.fn())

    await expect(scheduler.idle()).resolves.toBeUndefined()
  })

  it('idle waits for every pending request to settle', async () => {
    const pending: Array<() => void> = []
    const reSolve: ReSolveFn = vi.fn(() => new Promise<void>(resolve => { pending.push(resolve) }))
    const scheduler = createWorkerSolveScheduler(() => reSolve)

    void scheduler.request(doc('a'))
    let settled = false
    const waiting = scheduler.idle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    pending[0]()
    await waiting
    expect(settled).toBe(true)
  })
})
