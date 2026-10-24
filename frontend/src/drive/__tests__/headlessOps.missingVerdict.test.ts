// @vitest-environment node
//
// D2 regression: a solve that answers nothing must not read as a clean build.
// The wedged kernel returned `{ result: {}, bodies: {} }`, which left the reply
// with `features: []` and `ok: true`: there was simply no verdict to report.
//
// The kernel is stubbed here on purpose: this pins the drive boundary's own
// invariant (every authored feature needs an answer), independent of whether
// the empty result came from a trap, a dead module or a future bug.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { MISSING_VERDICT_MESSAGE } from '../featureOutcome'

vi.mock('@/kernel/solveLocally', () => ({
  solveLocally: vi.fn(),
  measureSolveFeatures: vi.fn(),
  buildAndMeasureLocally: vi.fn(),
  exportLocally: vi.fn(),
  exportAssemblyLocally: vi.fn(),
}))

const kernel = await import('@/kernel/solveLocally')
const { runHeadless, measureHeadless } = await import('../headlessOps')

const emptyBuild = {
  result: {},
  bodies: {},
  _build_state: { feature_order: [], checkpoints: {} },
}

describe('a settle with no verdicts', () => {
  beforeEach(() => {
    vi.mocked(kernel.solveLocally).mockReset()
    vi.mocked(kernel.solveLocally).mockResolvedValue(emptyBuild as never)
    vi.mocked(kernel.measureSolveFeatures).mockReset()
    vi.mocked(kernel.measureSolveFeatures).mockResolvedValue([])
  })

  it('reports a run with an empty result as a missing verdict, not ok', async () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude' }],
    } as PartDoc
    const result = await runHeadless({ doc, steps: [] })
    expect(result.ok).toBe(false)
    expect(result.solve.lastError).toBeNull()
    expect(result.features).toEqual([
      { id: 'ex1', kind: 'extrude', status: 'missing', message: MISSING_VERDICT_MESSAGE },
    ])
  })

  it('reports an empty measure as ok:false with the same problem row', async () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude' }],
    } as PartDoc
    vi.mocked(kernel.buildAndMeasureLocally).mockResolvedValue({
      response: emptyBuild,
      measures: {
        bodies: 0, volume: 0, area: 0, centroid: [0, 0, 0], bbox: [0, 0, 0, 0, 0, 0],
        faces: 0, edges: 0, vertices: 0, perBody: [],
      },
    } as never)
    const measured = await measureHeadless(doc)
    expect(measured).not.toBeNull()
    expect(measured!.ok).toBe(false)
    expect(measured!.features).toEqual([
      { id: 'ex1', kind: 'extrude', status: 'missing', message: MISSING_VERDICT_MESSAGE },
    ])
  })
})
