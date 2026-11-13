// @vitest-environment node
//
// A failed run must report the state it holds, not invent per-feature verdicts
// for a document that was never solved. The two states are pinned here: a
// script refused before any mutation landed (it settles the input document, so
// its existing warning rows reach `features`) and an inspect call that did
// settle (solved true, the real verdicts). The kernel is stubbed so the
// boundary's own decision is tested, not a build.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { DocHandleStore } from '../docHandleStore'
import { runReply } from '../mcpDocRef'

vi.mock('@/kernel/solveLocally', async importOriginal => {
  const actual = await importOriginal<typeof import('@/kernel/solveLocally')>()
  return {
    ...actual,
    solveLocally: vi.fn(),
    measureSolveFeatures: vi.fn(),
    buildAndMeasureLocally: vi.fn(),
    exportLocallyInspect: vi.fn(),
    exportAssemblyLocally: vi.fn(),
  }
})

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
// extrude's live body in the last checkpoint (the summary's body source), no
// missing verdicts.
const cleanBuild = {
  result: {
    sk1: { status: 'underconstrained' },
    ex1: { status: 'ok', body_id: 'body_ex1' },
  },
  bodies: { body_ex1: { created_by: 'ex1' } },
  _build_state: {
    feature_order: ['sk1', 'ex1'],
    checkpoints: {
      sk1: { body_store_snapshot: {} },
      ex1: { body_store_snapshot: { body_ex1: { shape: 1 } } },
    },
  },
}

describe('the state a run reports', () => {
  beforeEach(() => {
    vi.mocked(kernel.solveLocally).mockReset()
    vi.mocked(kernel.solveLocally).mockResolvedValue(cleanBuild as never)
    vi.mocked(kernel.measureSolveFeatures).mockReset()
    vi.mocked(kernel.measureSolveFeatures).mockResolvedValue([])
  })

  it('a refused-only script settles the input document for its verdict', async () => {
    // The real kernel carries an underconstrained sketch's warning text; the
    // stub mirrors that so the row proves the verdict landed on the reply.
    vi.mocked(kernel.solveLocally).mockResolvedValue({
      ...cleanBuild,
      result: {
        ...cleanBuild.result,
        sk1: { status: 'underconstrained', solver_warning: 'Underconstrained: 4 degree(s) of freedom.' },
      },
    } as never)
    const result = await runHeadless({
      doc: twoFeatureDoc(),
      // An unknown command is refused at the registry, before any mutation
      // lands, so the steps request no solve. The reply still settles the input
      // document: the sketch is underconstrained, and that must not read as a
      // clean build.
      steps: [{ command: 'noop_probe' }],
    })
    expect(result.ok).toBe(false)
    expect(result.solved).toBe(true)
    expect(result.features).toContainEqual(expect.objectContaining({ id: 'sk1', status: 'underconstrained' }))
    expect(result.bodies).toEqual(['body_ex1'])
    expect(result.solve.lastError).toBeNull()

    const reply = runReply(result, false, new DocHandleStore())
    expect(reply.solved).toBe(true)
    expect(reply.summary).toContain('sk1 (sketch)')
    expect(reply.summary).toContain('step 0 refused')
    expect(reply.summary).not.toContain('not solved')
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
