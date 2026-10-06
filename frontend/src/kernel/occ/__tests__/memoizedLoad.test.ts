// memoizedLoad memoizes a loader per successful result: a null (or rejected)
// load is a miss and must be retried, not pinned for the session. These are the
// semantics the OCC loaders (loadOcc, loadOccWorker) rely on to degrade and
// then recover when the artifact appears later.
import { describe, it, expect, vi } from 'vitest'
import { memoizedLoad } from '../memoizedLoad'

describe('memoizedLoad', () => {
  it('caches a successful result and ignores later args', async () => {
    const loader = vi.fn(async (n: number) => ({ n }))
    const { load } = memoizedLoad(loader)
    const first = load(1)
    const second = load(2)
    expect(second).toBe(first)
    expect(await first).toEqual({ n: 1 })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('does not pin a null result: the next call retries and uses the success', async () => {
    const loader = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ready: true })
    const { load } = memoizedLoad(loader)
    expect(await load()).toBeNull()
    // The null was evicted, so this is a fresh load whose result is kept.
    expect(await load()).toEqual({ ready: true })
    expect(await load()).toEqual({ ready: true })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('does not pin a rejection: the next call retries', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ready: true })
    const { load } = memoizedLoad(loader)
    await expect(load()).rejects.toThrow('boom')
    expect(await load()).toEqual({ ready: true })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight promise across concurrent calls', async () => {
    let release!: (v: unknown) => void
    const gate = new Promise((r) => { release = r })
    const loader = vi.fn(() => gate)
    const { load } = memoizedLoad(loader)
    const a = load()
    const b = load()
    expect(b).toBe(a)
    release({ ready: true })
    expect(await a).toEqual({ ready: true })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('a stale null resolution does not clobber the cell a reset then reload installed', async () => {
    let releaseStale!: (v: null) => void
    const stale = new Promise<null>((r) => { releaseStale = r })
    const loader = vi.fn()
      .mockImplementationOnce(() => stale)
      .mockResolvedValueOnce({ ready: true })
    const { load, reset } = memoizedLoad(loader)

    const first = load()
    // reset + a fresh load replace the cell before the first load resolves.
    reset()
    const second = load()
    expect(await second).toEqual({ ready: true })
    // The stale load resolves null only after the cell already holds the fresh
    // promise; the identity guard must keep it from evicting that cell.
    releaseStale(null)
    await first
    expect(await load()).toEqual({ ready: true })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('reset clears the cell so the loader runs again', async () => {
    const loader = vi.fn(async () => ({ n: 1 }))
    const { load, reset } = memoizedLoad(loader)
    await load()
    reset()
    await load()
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
