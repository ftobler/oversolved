// L42 review-17 regression: solveLocally logged on every solve unconditionally
// while sibling modules gated via isDevBuild(). The helper now lives once
// (kernel/isDevBuild.ts) and the hot-path diagnostics honor it. The gate module
// is mocked rather than env-stubbed: vitest cannot flip import.meta.env.DEV
// per-test, but mocking pins the exact contract under test -- solveLocally's
// logging goes through the shared gate and stays silent in production mode.

import { describe, it, expect, vi, afterEach } from 'vitest'

const devGate = vi.hoisted(() => ({ value: true }))

vi.mock('./isDevBuild', () => ({
  isDevBuild: () => devGate.value,
  isDevOrTestBuild: () => devGate.value,
}))

import { solveLocally, setSolveLocalsForTest } from './solveLocally'

const emptyDoc = { id: 'doc-devlog', features: [] }

afterEach(() => {
  devGate.value = true
  setSolveLocalsForTest(null)
  vi.restoreAllMocks()
})

describe('solveLocally build diagnostics are dev-gated', () => {
  it('logs the OCC outcome through the shared dev gate', async () => {
    // A loader with no OCC is the cheapest way to reach the diagnostic: it
    // takes the "not available" branch on every solve.
    setSolveLocalsForTest(async () => null)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    devGate.value = true
    await solveLocally(emptyDoc)
    expect(logSpy).toHaveBeenCalledWith('[solveLocally] OCC.js not available, returning null')

    logSpy.mockClear()
    devGate.value = false
    const out = await solveLocally(emptyDoc)
    expect(out).toBeNull()
    expect(logSpy).not.toHaveBeenCalled()
  })
})
