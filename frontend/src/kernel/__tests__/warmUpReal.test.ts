// @vitest-environment node
//
// The idle kernel warm-up (occ/warmUp.ts, solveLocally's warmUpLocally) runs
// real OCC work between requests, so it must leave nothing a solve can see: no
// handle in the persistent table, no checkpoint, and the same reply for the
// next solve as without it.
//
// The real kernel is required; this skips like the other gated Real suites.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { solveLocally, setSolveLocalsForTest, persistentTableForTest, warmUpLocally } from '../solveLocally'
import { resetSketchSolver, setSketchSolver } from '../features/sketch'
import { WARM_UP_STEPS, type WarmUpState } from '../occ/warmUp'

const oc = await loadOcc()
const solveBytes = oc ? loadSolver() : null

const STEP = oc
  ? new Uint8Array(readFileSync(join(__dirname, '../occ/__fixtures__/double_with_hole.step')))
  : new Uint8Array()

function importDoc(id: string): Record<string, unknown> {
  return { id, features: [{ id: 'imp1', kind: 'import_step', file_id: 'imp1', scale: 1 }] }
}

/** The reply without the parts that legitimately differ between two solves:
 *  wall-clock timings (the top-level and each feature's `solve_ms`), the
 *  generation stamp and the worker-owned build state. */
function comparable(res: Awaited<ReturnType<typeof solveLocally>>): unknown {
  const { solve_ms: _ms, generation: _gen, _build_state: _state, ...rest } = res!
  return JSON.parse(JSON.stringify(rest, (key, value) => (key === 'solve_ms' ? undefined : value)))
}

async function warmAll(): Promise<number> {
  const state: WarmUpState = {}
  let ran = 0
  while (await warmUpLocally(ran, state)) ran++
  return ran
}

describe.skipIf(!oc || !solveBytes)('kernel warm-up (real OCC)', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('every step runs clean on its own', () => {
    // Unwrapped: warmUpLocally logs a failing step and moves on, so only a
    // direct call can see a step that throws.
    const state: WarmUpState = {}
    for (const step of WARM_UP_STEPS) step(oc!, state)
    expect(state.step?.length).toBeGreaterThan(0)
  })

  it('runs every step and leaves the persistent table as it found it', async () => {
    const files = new Map([['imp1', STEP]])
    await solveLocally(importDoc('warm-a'), { files })
    const table = persistentTableForTest()!
    const before = table.liveHandles().length
    expect(await warmAll()).toBe(WARM_UP_STEPS.length)
    expect(table.liveHandles().length).toBe(before)
  })

  it('does not change the next solve\'s reply', async () => {
    const files = new Map([['imp1', STEP]])
    const cold = await solveLocally(importDoc('warm-b'), { files, bypassCache: true })
    await warmAll()
    const warm = await solveLocally(importDoc('warm-b'), { files, bypassCache: true })
    expect(comparable(warm)).toEqual(comparable(cold))
  })
})
