// @vitest-environment node
// The SolveScheduler contract, pinned against the deterministic fake the
// session suites inject. The worker-backed adapter that lands with the React
// change must satisfy the same rows; this suite is the reference model.
import { describe, it, expect } from 'vitest'
import { createFakeSolveScheduler } from './fakeSolveScheduler'

describe('the solve scheduler contract', () => {
  it('advances the generation once per request and records the call', () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    void solve.request({ id: 1 })
    void solve.request({ id: 2 }, { bypassCache: true, _suppressFirstSolve: true })

    expect(solve.state().generation).toBe(2)
    expect(solve.calls.map(call => call.generation)).toEqual([1, 2])
    expect(solve.calls[1]).toEqual({
      generation: 2,
      doc: { id: 2 },
      opts: { bypassCache: true, _suppressFirstSolve: true },
    })
  })

  it('adopts only the newest outcome, dropping the superseded one', async () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    const first = solve.request({ id: 1 })
    const second = solve.request({ id: 2 })

    solve.flush()

    await expect(first).resolves.toEqual({ generation: 1, status: 'superseded' })
    await expect(second).resolves.toEqual({ generation: 2, status: 'applied' })
    expect(solve.appliedGenerations).toEqual([2])
  })

  it('applies a lone request', async () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    const only = solve.request({ id: 1 })
    solve.flush()

    await expect(only).resolves.toEqual({ generation: 1, status: 'applied' })
    expect(solve.appliedGenerations).toEqual([1])
  })

  it('drops a stale outcome that settles while a newer request is pending', async () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    const first = solve.request({ id: 1 })
    const second = solve.request({ id: 2 })

    solve.flushOne()
    await expect(first).resolves.toEqual({ generation: 1, status: 'superseded' })
    expect(solve.state().pending).toBe(true)
    expect(solve.appliedGenerations).toEqual([])

    solve.flushOne()
    await expect(second).resolves.toEqual({ generation: 2, status: 'applied' })
    expect(solve.state().pending).toBe(false)
  })

  it('reports pending and running while a request waits, and neither after it settles', () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    expect(solve.state()).toEqual({ generation: 0, pending: false, running: false, lastError: null })

    void solve.request({ id: 1 })
    expect(solve.state().pending).toBe(true)
    expect(solve.state().running).toBe(true)

    solve.flush()
    expect(solve.state().pending).toBe(false)
    expect(solve.state().running).toBe(false)
  })

  it('resolves idle immediately when nothing is pending', async () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    await expect(solve.idle()).resolves.toBeUndefined()
  })

  it('idle waits for every pending request to settle', async () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    void solve.request({ id: 1 })
    let settled = false
    const waiting = solve.idle().then(() => { settled = true })

    await Promise.resolve()
    expect(settled).toBe(false)

    solve.flush()
    await waiting
    expect(settled).toBe(true)
  })

  it('a failed solve settles as an error outcome and is not adopted', async () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    solve.failNext('worker crashed')
    const request = solve.request({ id: 1 })
    solve.flush()

    await expect(request).resolves.toEqual({ generation: 1, status: 'error', error: 'worker crashed' })
    expect(solve.state().lastError).toBe('worker crashed')
    expect(solve.appliedGenerations).toEqual([])
  })

  it('a new request clears the previous error from the state', () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    solve.failNext('boom')
    void solve.request({ id: 1 })
    solve.flush()
    expect(solve.state().lastError).toBe('boom')

    void solve.request({ id: 2 })
    expect(solve.state().lastError).toBeNull()
  })

  it('a stale failure of a superseded request does not touch lastError', async () => {
    const solve = createFakeSolveScheduler<{ id: number }>()
    void solve.request({ id: 1 })
    const second = solve.request({ id: 2 })
    // The first request is superseded; only the second one fails.
    solve.failNext('newest failed')
    solve.flush()

    await expect(second).resolves.toEqual({ generation: 2, status: 'error', error: 'newest failed' })
    expect(solve.state().lastError).toBe('newest failed')
  })
})
