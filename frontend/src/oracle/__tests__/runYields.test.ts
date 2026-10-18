// buildAndMeasure must hand the event loop a macrotask per build. The real
// kernel settles every await as a microtask, so a corpus loop over it (the
// doc-ref-canon suite) otherwise held a vitest fork's loop for its whole run
// and, on a slow CI runner, tripped birpc's 60 s `onTaskUpdate` timeout.
import { describe, it, expect, vi } from 'vitest'
import type { OccModule } from '@/kernel/occ/occTypes'

// A kernel that answers instantly through microtasks only, like the real one.
vi.mock('@/kernel/solveLocally', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kernel/solveLocally')>()),
  solveLocally: async () => null,
}))

const { buildAndMeasure } = await import('@/oracle/run')

describe('buildAndMeasure', () => {
  it('lets a pending macrotask run before the build settles', async () => {
    let ticked = false
    setTimeout(() => { ticked = true }, 0)
    // The null response is the broken-kernel throw; the yield precedes it.
    await expect(buildAndMeasure({} as OccModule, {})).rejects.toThrow(/solveLocally returned null/)
    expect(ticked).toBe(true)
  })
})
