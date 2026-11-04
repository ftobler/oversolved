// @vitest-environment node
//
// A failed run must report the state it holds, not invent per-feature verdicts
// for a document that was never solved. The two states are pinned here: a
// script refused before any mutation landed (solved false, no problem rows) and
// an inspect call that did settle (solved true, the real verdicts). The kernel
// is stubbed so the boundary's own decision is tested, not a build.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { DocHandleStore } from '../docHandleStore'
import { runReply } from '../mcpDocRef'

vi.mock('@/kernel/solveLocally', () => ({
  solveLocally: vi.fn(),
  measureSolveFeatures: vi.fn(),
  buildAndMeasureLocally: vi.fn(),
  exportLocallyInspect: vi.fn(),
  exportAssemblyLocally: vi.fn(),
}))

const kernel = await import('@/kernel/solveLocally')
const { runHeadless } = await import('../headlessOps')

// A sketch plus an extrude: the smallest document where the old reply invented
// two missing rows for a run that never asked the kernel anything.
function twoFeatureDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
    ],
  } as PartDoc
}

// What a clean settle answers for the same document: the sketch state and the
// extrude's live body, no missing verdicts.
const cleanBuild = {
  result: {
    sk1: { status: 'underconstrained' },
    ex1: { status: 'ok', body_id: 'body_ex1' },
  },
  bodies: { body_ex1: { created_by: 'ex1' } },
  _build_state: { feature_order: ['sk1', 'ex1'], checkpoints: {} },
}

describe('the state a run reports', () => {
  beforeEach(() => {
    vi.mocked(kernel.solveLocally).mockReset()
    vi.mocked(kernel.solveLocally).mockResolvedValue(cleanBuild as never)
    vi.mocked(kernel.measureSolveFeatures).mockReset()
    vi.mocked(kernel.measureSolveFeatures).mockResolvedValue([])
  })

  it('a refused-only script is unsolved and has no verdicts to report', async () => {
    const result = await runHeadless({
      doc: twoFeatureDoc(),
      // An unknown command is refused at the registry, before any mutation
      // lands, so no solve is requested for this document at all.
      steps: [{ command: 'noop_probe' }],
    })
    expect(result.ok).toBe(false)
    expect(result.solved).toBe(false)
    expect(result.features).toEqual([])
    expect(result.bodies).toBeNull()
    expect(result.featureDeltas).toBeNull()
    expect(result.frames).toBeNull()
    expect(result.solve.lastError).toBeNull()

    const reply = runReply(result, false, new DocHandleStore())
    expect(reply.solved).toBe(false)
    expect(reply.summary).toBe('features: sk1 (sketch), ex1 (extrude); bodies: not solved (step 0 refused)')
  })

  it('an inspect call holds solved verdicts and the live bodies', async () => {
    const result = await runHeadless({ doc: twoFeatureDoc(), steps: [] })
    expect(result.ok).toBe(true)
    expect(result.solved).toBe(true)
    expect(result.features).toEqual([])
    expect(result.bodies).toEqual(['body_ex1'])

    const reply = runReply(result, false, new DocHandleStore())
    expect(reply.solved).toBe(true)
    expect(reply.summary).toContain('bodies: body_ex1')
  })
})
