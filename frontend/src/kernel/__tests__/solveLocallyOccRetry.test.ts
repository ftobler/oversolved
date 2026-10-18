// @vitest-environment node
//
// A failed OCC load must not pin "OCC unavailable" for the module's lifetime.
// `memoizedLoad` (and the loadOcc* loaders on top of it) evicts a null result
// so the next call retries, and solveLocally's cell has to keep that contract:
// the Worker preloads the kernel at spawn through `preloadOcc`, so that first
// load is the only early attempt. Pinning it leaves every later solve
// reporting "local solver unavailable" until the Worker happens to be replaced.
//
// No OCC needed: an empty doc never dereferences the module, so a stand-in is
// enough to drive the load gating.

import { describe, it, expect, afterEach } from 'vitest'
import { preloadOcc, solveLocally, setSolveLocalsForTest } from '../solveLocally'
import type { OccModule } from '../occ/occTypes'

const emptyDoc = { id: 'doc-occ-retry', features: [] }
const FAKE_OCC = { fake: 'occ' } as unknown as OccModule

describe('solveLocally OCC load retry', () => {
  afterEach(() => {
    setSolveLocalsForTest(null)
  })

  it('retries a failed OCC load on the next solve instead of pinning the null', async () => {
    let calls = 0
    setSolveLocalsForTest(async () => {
      calls++
      return calls === 1 ? null : FAKE_OCC
    })

    // First load fails: this solve degrades to null ("local solver unavailable").
    expect(await solveLocally(emptyDoc)).toBeNull()

    // The failed load was evicted, so the next solve asks the loader again and
    // builds once it answers with a module, instead of replaying the pinned null.
    const second = await solveLocally(emptyDoc)
    expect(calls).toBe(2)
    expect(second).not.toBeNull()
  })

  it('keeps a successful load cached, so a retry does not re-download', async () => {
    let calls = 0
    setSolveLocalsForTest(async () => {
      calls++
      return FAKE_OCC
    })

    await solveLocally(emptyDoc)
    await solveLocally(emptyDoc)
    expect(calls).toBe(1)
  })

  it('retries through preloadOcc, the Worker-spawn path', async () => {
    let calls = 0
    setSolveLocalsForTest(async () => {
      calls++
      return calls === 1 ? null : FAKE_OCC
    })

    expect(await preloadOcc()).toBeNull()
    expect(await preloadOcc()).toBe(FAKE_OCC)
    expect(calls).toBe(2)
  })
})
