// @vitest-environment node
//
// `solveLocally` owns module-level cross-solve state (the persistent
// HandleTable, the last BuildState, the last doc id). Nothing in this module
// serializes access to it: production relies on the WorkerActor, which is out
// of scope here, so an overlapping call has to be refused loudly instead of
// interleaving two builds over one handle table (a doc switch in the second
// call would reset the table the first is still building on).
//
// No OCC needed: the guard has to hold from the very first await, so a loader
// that never resolves is exactly the window under test.

import { describe, it, expect, afterEach } from 'vitest'
import { solveLocally, setSolveLocalsForTest } from './solveLocally'

/** A loader stuck until the test releases it, so the first solve stays parked
 *  inside its await while the second call is made. */
function parkedLoader(): { loader: () => Promise<null>; release: () => void } {
  let release: () => void = () => {}
  const parked = new Promise<null>((resolve) => {
    release = () => resolve(null)
  })
  return { loader: () => parked, release }
}

const emptyDoc = { id: 'doc-reentrancy', features: [] }

describe('solveLocally reentrancy guard', () => {
  afterEach(() => {
    setSolveLocalsForTest(null)
  })

  it('refuses a second solve while one is in flight', async () => {
    const { loader, release } = parkedLoader()
    setSolveLocalsForTest(loader)

    const first = solveLocally(emptyDoc)
    await expect(solveLocally(emptyDoc)).rejects.toThrow(/already in flight/)

    release()
    await expect(first).resolves.toBeNull()
  })

  it('releases the guard once the solve settles', async () => {
    const { loader, release } = parkedLoader()
    setSolveLocalsForTest(loader)

    const first = solveLocally(emptyDoc)
    await expect(solveLocally(emptyDoc)).rejects.toThrow(/already in flight/)
    release()
    await first

    // The guard is a serializer, not a one-shot latch: the next solve must run.
    await expect(solveLocally(emptyDoc)).resolves.toBeNull()
  })

  it('releases the guard when the solve throws', async () => {
    // The failure is injected inside the loader rather than by re-installing the
    // test seam, so the guard is only ever cleared by solveLocally's own finally.
    let calls = 0
    setSolveLocalsForTest(() => {
      calls++
      if (calls === 1) throw new Error('loader exploded')
      return Promise.resolve(null)
    })

    await expect(solveLocally(emptyDoc)).rejects.toThrow(/loader exploded/)

    // A failed solve must not wedge every later solve.
    await expect(solveLocally(emptyDoc)).resolves.toBeNull()
  })
})
