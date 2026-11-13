// @vitest-environment node
//
// A run reply's body list names what the solve holds, not what rendered. The
// response's `bodies` map is the tessellation, which drops a body whose
// tessellation failed while the solve still measures it; the summary must name
// the checkpoint body store instead, or it disagrees with `measure` and with
// the reply's own featureDeltas row. The kernel is mocked: the defect is at the
// drive boundary, not in the build.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BuildResponse, PartDoc } from '@/types/cad'

vi.mock('@/kernel/solveLocally', async importOriginal => {
  const actual = await importOriginal<typeof import('@/kernel/solveLocally')>()
  return {
    ...actual,
    solveLocally: vi.fn(),
    measureSolveFeatures: vi.fn(),
  }
})

import { finalLiveBodyIds } from '@/kernel/solveLocally'
import { runHeadless } from '../headlessOps'
import { DocHandleStore } from '../docHandleStore'
import { runReply, summarizeDoc } from '../mcpDocRef'
import type { FeatureDelta } from '../featureDeltas'

const kernel = await import('@/kernel/solveLocally')

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

// The torus shape of the report: the solve holds four bodies, but the mocked
// tessellation rendered only three, so `bodies` is the render map that omits
// body_swD.
const RESPONSE = {
  solve_ms: 1,
  result: {
    sk1: { status: 'fully_constrained' },
    ex1: { status: 'ok', body_id: 'body_swD' },
  },
  bodies: {
    body_rvA: { created_by: 'ex1' },
    body_rvB: { created_by: 'ex1' },
    body_rvC: { created_by: 'ex1' },
  },
  _build_state: {
    feature_order: ['sk1', 'ex1'],
    checkpoints: {
      sk1: { body_store_snapshot: {} },
      ex1: {
        body_store_snapshot: {
          body_rvA: { shape: 1 },
          body_rvB: { shape: 2 },
          body_rvC: { shape: 3 },
          body_swD: { shape: 4 },
        },
      },
    },
  },
} as unknown as BuildResponse

describe('finalLiveBodyIds', () => {
  it('returns the shape-bearing bodies of the last checkpoint', () => {
    const response = {
      ...RESPONSE,
      _build_state: {
        feature_order: ['sk1', 'ex1'],
        checkpoints: {
          sk1: { body_store_snapshot: {} },
          ex1: {
            body_store_snapshot: {
              body_a: { shape: 1 },
              body_b: { shape: 2 },
              body_without_geometry: { shape: null },
            },
          },
        },
      },
    } as unknown as BuildResponse
    expect(finalLiveBodyIds(response)).toEqual(['body_a', 'body_b'])
  })

  it('returns an empty list for a solved document with no features and null without build state', () => {
    expect(finalLiveBodyIds({
      _build_state: { feature_order: [], checkpoints: {} },
    } as unknown as BuildResponse)).toEqual([])
    expect(finalLiveBodyIds({} as BuildResponse)).toBeNull()
  })
})

describe('the run summary body source', () => {
  beforeEach(() => {
    vi.mocked(kernel.solveLocally).mockReset()
    vi.mocked(kernel.solveLocally).mockResolvedValue(RESPONSE as never)
    vi.mocked(kernel.measureSolveFeatures).mockReset()
    vi.mocked(kernel.measureSolveFeatures).mockResolvedValue([
      { id: 'sk1', volume: 0, bbox: null, bodies: {} },
      {
        id: 'ex1', volume: 50, bbox: [0, 0, 0, 1, 1, 1],
        bodies: {
          body_rvA: { volume: 5, faces: 6, edges: 12 },
          body_rvB: { volume: 5, faces: 6, edges: 12 },
          body_rvC: { volume: 5, faces: 6, edges: 12 },
          body_swD: { volume: 35, faces: 6, edges: 12 },
        },
      },
    ])
  })

  it('names the checkpoint body the tessellation omitted, as measure does', async () => {
    const result = await runHeadless({ doc: twoFeatureDoc(), steps: [], featureDeltas: 'all' })
    expect(result.bodies).toEqual(['body_rvA', 'body_rvB', 'body_rvC', 'body_swD'])
    const reply = runReply(result, false, new DocHandleStore())
    expect(reply.summary).toContain('bodies: body_rvA, body_rvB, body_rvC, body_swD')
  })

  it('keeps a featureDeltas row body inside the summary body list', async () => {
    const result = await runHeadless({ doc: twoFeatureDoc(), steps: [], featureDeltas: 'all' })
    const reply = runReply(result, false, new DocHandleStore())
    const summary = String(reply.summary)
    const row = (reply.featureDeltas as FeatureDelta[]).find(candidate => candidate.id === 'ex1')
    expect(row?.body).toBe('body_swD')
    expect(summary).toContain(`bodies: ${result.bodies?.join(', ')}`)
  })

  it('keeps a refused step and an empty settle as different answers', async () => {
    const refused = await runHeadless({
      doc: twoFeatureDoc(),
      steps: [{ command: 'noop_probe' }],
      featureDeltas: 'all',
    })
    // A refused-only script settles the input document, so the reply carries
    // that live set and says which step was refused, not "not solved".
    expect(refused.bodies).toEqual(['body_rvA', 'body_rvB', 'body_rvC', 'body_swD'])
    expect(refused.solved).toBe(true)
    const summary = String(runReply(refused, false, new DocHandleStore()).summary)
    expect(summary).toContain('step 0 refused, not applied')
    expect(summary).not.toContain('not solved')
    // summarizeDoc still words a solve that never ran, for a caller that hands
    // it no live set; a refused run now always has one.
    expect(summarizeDoc(twoFeatureDoc(), null, { index: 0, code: 'invalid-mutation', id: 'noop_probe' }))
      .toContain('bodies: not solved (step 0 refused)')

    vi.mocked(kernel.solveLocally).mockResolvedValue({
      ...RESPONSE,
      result: { sk1: { status: 'fully_constrained' } },
      bodies: {},
      _build_state: { feature_order: ['sk1'], checkpoints: { sk1: { body_store_snapshot: {} } } },
    } as never)
    const empty = await runHeadless({
      doc: { version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch' }] } as PartDoc,
      steps: [],
      featureDeltas: 'all',
    })
    expect(empty.bodies).toEqual([])
    expect(runReply(empty, false, new DocHandleStore()).summary).toContain('bodies: none')
  })
})
