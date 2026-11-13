// @vitest-environment node
//
// The headless run defers its solves: a mutation requests one and the run
// spends it once at the end, instead of solving after every step. The kernel is
// stubbed so the count is exact. One baseline solve still happens when a reply
// filter needs the input document's solve, which is why the one-solve cases
// pass both opt-ins.
//
// A selector step needs solved bodies, so it flushes first; a command step is
// registry code, so it flushes before it runs. A refused-only script owes no
// step solve; the run asks for the input document's verdict explicitly.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BodyResult, PartDoc } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { emptyDriveDoc } from '../headlessOps'
import { createHeadlessPart, SETTLE_PASSES } from '../headlessPart'
import type { ScriptStep } from '../scriptRunner'

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

interface PayloadFeature {
  id: string
  kind: string
}

// What a clean solve answers for whatever the payload carries: sketches are
// underconstrained, every other feature builds. No bodies by default, so the
// document write-back only moves the authored state the tests never read.
function cleanBuild(payload: { features?: PayloadFeature[] }) {
  const features = payload.features ?? []
  const result: Record<string, unknown> = {}
  for (const feature of features) {
    result[feature.id] = feature.kind === 'sketch'
      ? { status: 'underconstrained' }
      : { status: 'ok', body_id: `body_${feature.id}` }
  }
  return {
    result,
    bodies: {},
    _build_state: { feature_order: features.map(f => f.id), checkpoints: {} },
  }
}

// One flat face on top, enough for a `parallel: [0, 0, 1]` selector to resolve
// against the body the step is building on.
function solvedBody(id: string): BodyResult {
  return {
    id,
    created_by: 'ex1',
    modified_by: [],
    edges: [],
    edge_queries: [],
    mesh: {
      vertices: [],
      faces: [],
      face_data: [{ centroid: [0, 0, 0], normal: [0, 0, 1], surface_type: 'flatface' }],
      face_queries: [makeAncestryQuery([`@${id}`, '@u|f_0'], 'flatface')],
      face_edge_queries: [[]],
    },
  } as BodyResult
}

const addSketch = (id: string): ScriptStep =>
  ({ mutation: { type: 'add_sketch', featureId: id, plane: '@builtin_plane_front' } })
const addRect = (id: string): ScriptStep =>
  ({ mutation: { type: 'add_rect', featureId: id, p0: [0, 0], p1: [10, 10] } })
const addExtrude = (featureId: string, sketch: string): ScriptStep =>
  ({ mutation: { type: 'add_extrude', featureId, label: featureId, sketchQuery: `$${sketch}`, distance: 5, operation: 'new' } })

// Five accepted mutations across two sketches and two extrudes.
function fiveMutations(): ScriptStep[] {
  return [
    addSketch('sk1'),
    addRect('sk1'),
    addExtrude('ex1', 'sk1'),
    addSketch('sk2'),
    addRect('sk2'),
  ]
}

describe('the headless run solves once per flush', () => {
  beforeEach(() => {
    vi.mocked(kernel.solveLocally).mockReset()
    vi.mocked(kernel.measureSolveFeatures).mockReset()
    vi.mocked(kernel.measureSolveFeatures).mockResolvedValue([])
    vi.mocked(kernel.solveLocally).mockImplementation(async payload => cleanBuild(payload as never) as never)
  })

  it('a five-mutation run with both filters all makes one solve', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: fiveMutations(),
      featureDeltas: 'all',
      frames: 'all',
    })
    expect(result.outcome.ok).toBe(true)
    expect(result.solved).toBe(true)
    expect(kernel.solveLocally).toHaveBeenCalledTimes(1)
    expect(result.solve.generation).toBe(1)
    expect(result.features).toEqual([])
  })

  it('the default reply pays the baseline plus the final solve, not one per step', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: fiveMutations() })
    expect(result.outcome.ok).toBe(true)
    // One baseline measurement of the input document and one final solve; the
    // five steps add nothing.
    expect(kernel.solveLocally).toHaveBeenCalledTimes(2)
    expect(result.solve.generation).toBe(1)
  })

  it('every step keeps its createdIds and one undo entry', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: fiveMutations(),
      featureDeltas: 'all',
      frames: 'all',
    })
    expect(result.outcome.steps.map(step => step.ok)).toEqual([true, true, true, true, true])
    expect(result.outcome.steps[1].createdIds).toHaveLength(4)
    expect(result.outcome.steps[4].createdIds).toHaveLength(4)
    expect(result.part.session.historyEntries().undo).toHaveLength(5)
  })

  it('a selector after three mutations flushes, then solves once at the end', async () => {
    vi.mocked(kernel.solveLocally).mockImplementation(async payload => {
      const build = cleanBuild(payload as never)
      return { ...build, bodies: { body_ex1: solvedBody('body_ex1') } } as never
    })
    const steps: ScriptStep[] = [
      addSketch('sk1'),
      addRect('sk1'),
      addExtrude('ex1', 'sk1'),
      {
        mutation: {
          type: 'add_sketch', featureId: 'sk2',
          plane: { selector: { kind: 'face', where: { parallel: [0, 0, 1] } } },
        },
      },
    ]
    const result = await runHeadless({ doc: emptyDriveDoc(), steps, featureDeltas: 'all', frames: 'all' })
    expect(result.outcome.ok).toBe(true)
    expect(result.outcome.steps[3].ok).toBe(true)
    expect(kernel.solveLocally).toHaveBeenCalledTimes(2)
    const sk2 = result.doc?.features?.find(feature => feature.id === 'sk2')
    expect(sk2?.kind === 'sketch' ? sk2.plane : undefined).toMatch(/^[?@]/)
  })

  it('a selector on the first step still solves before resolving it', async () => {
    vi.mocked(kernel.solveLocally).mockImplementation(async payload => {
      const build = cleanBuild(payload as never)
      return { ...build, bodies: { body_ex1: solvedBody('body_ex1') } } as never
    })
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [{
        mutation: {
          type: 'add_sketch', featureId: 'sk1',
          plane: { selector: { kind: 'face', where: { parallel: [0, 0, 1] } } },
        },
      }],
      featureDeltas: 'all',
      frames: 'all',
    })
    expect(result.outcome.ok).toBe(true)
    expect(kernel.solveLocally).toHaveBeenCalledTimes(2)
  })

  it('a geometry-reading mutation flushes before it runs', async () => {
    const steps: ScriptStep[] = [
      addSketch('sk1'),
      { mutation: { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 0], entityId: 'l1' } },
      { mutation: { type: 'move_entity', featureId: 'sk1', entityId: 'l1', delta: [1, 0] } },
    ]
    const result = await runHeadless({ doc: emptyDriveDoc(), steps, featureDeltas: 'all', frames: 'all' })
    expect(result.outcome.ok).toBe(true)
    // One flush before the move (which reads the solved params), one final.
    expect(kernel.solveLocally).toHaveBeenCalledTimes(2)
  })

  it('a command step flushes before it runs', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [...fiveMutations(), { command: 'undo' }],
      featureDeltas: 'all',
      frames: 'all',
    })
    expect(result.outcome.ok).toBe(true)
    // One flush before the undo and one for the document its re-solve owes.
    expect(kernel.solveLocally).toHaveBeenCalledTimes(2)
    expect(result.outcome.steps[5].ok).toBe(true)
  })

  it('a failed step stops the script and the final flush still runs', async () => {
    const steps: ScriptStep[] = [
      addSketch('sk1'),
      { mutation: { type: 'not_a_mutation' } } as unknown as ScriptStep,
      addRect('sk1'),
    ]
    const result = await runHeadless({ doc: emptyDriveDoc(), steps, featureDeltas: 'all', frames: 'all' })
    expect(result.outcome.ok).toBe(false)
    expect(result.outcome.steps).toHaveLength(2)
    expect(result.outcome.steps[1].error?.code).toBe('unknown-mutation')
    // One solve for the mutation that landed, one no-op would be wrong: only
    // the final flush runs.
    expect(kernel.solveLocally).toHaveBeenCalledTimes(1)
    expect(result.solved).toBe(true)
    expect(result.features).toEqual([])
  })

  it('a refused-only script settles the input document once', async () => {
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [{ command: 'noop_probe' }],
      featureDeltas: 'all',
      frames: 'all',
    })
    expect(result.outcome.ok).toBe(false)
    // No step landed, so no step requested a solve; the run still asks for the
    // input document's verdict, which is the one solve.
    expect(result.solved).toBe(true)
    expect(kernel.solveLocally).toHaveBeenCalledTimes(1)
  })

  it('an empty-steps run still solves once', async () => {
    const result = await runHeadless({ doc: emptyDriveDoc(), steps: [], featureDeltas: 'all', frames: 'all' })
    expect(result.solved).toBe(true)
    expect(kernel.solveLocally).toHaveBeenCalledTimes(1)
    expect(result.solve.generation).toBe(1)
  })

  it('mutation, requestSolve and undo/redo requests wait for one flush', async () => {
    const part = createHeadlessPart({ doc: emptyDriveDoc() })
    expect(part.session.execute({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }).ok).toBe(true)
    // The non-mutation request paths the session owns all land on the same
    // scheduler, so a deferral that only covered solveAfterMutation would leak
    // a solve here.
    part.session.refreshSolve()
    expect(part.session.undo()).toBe(true)
    expect(part.session.redo()).toBe(true)
    expect(part.solve.owed()).toBe(true)
    expect(kernel.solveLocally).not.toHaveBeenCalled()

    await part.solve.flush()
    expect(part.solve.owed()).toBe(false)
    expect(kernel.solveLocally).toHaveBeenCalledTimes(1)
    expect(part.solve.state().generation).toBe(1)
  })
})

// ─── the settle on the stored document ───

// The reply is built from a solve of the document its docHash names. The
// write-back can install fresh sketch geometry (the solve rounded to the 1e-6
// grid); a solve of that stored document can land elsewhere, so the flush
// solves once more. The stub below controls exactly when that happens: a
// sketch with no constraint re-derives its stored initial, and a constrained
// one moves to a fixed target, which the next pass then keeps.

interface StubSketch {
  id: string
  kind: string
  initial?: Record<string, number[]>
  constraints?: unknown[]
}

function geometryBuild(payload: { features?: StubSketch[] }) {
  const features = payload.features ?? []
  const result: Record<string, unknown> = {}
  for (const feature of features) {
    if (feature.kind === 'sketch') {
      const moved = (feature.constraints ?? []).length > 0
      result[feature.id] = {
        status: 'underconstrained',
        geometry: moved ? { l1: [0, 0, 1.001, 0] } : (feature.initial ?? { l1: [0, 0, 1, 0] }),
      }
    } else {
      result[feature.id] = { status: 'ok', body_id: `body_${feature.id}` }
    }
  }
  return {
    result,
    bodies: {},
    _build_state: { feature_order: features.map(feature => feature.id), checkpoints: {} },
  }
}

function sketchAndExtrude(constraints: unknown[] = []): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'sk1',
        kind: 'sketch',
        plane: '@builtin_plane_front',
        entities: [{ id: 'l1', kind: 'line' }],
        constraints,
        initial: { l1: [0, 0, 1, 0] },
      },
      { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 5 } },
    ],
  } as unknown as PartDoc
}

const setExtrudeDistance: ScriptStep = {
  mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'distance', value: 7 },
}
const addHorizontal: ScriptStep = {
  mutation: { type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:l1'] },
}

describe('the headless flush settles on the stored document', () => {
  beforeEach(() => {
    vi.mocked(kernel.solveLocally).mockReset()
    vi.mocked(kernel.measureSolveFeatures).mockReset()
    vi.mocked(kernel.measureSolveFeatures).mockResolvedValue([])
  })

  it('T4: an edit that moves no sketch geometry pays one solve', async () => {
    vi.mocked(kernel.solveLocally).mockImplementation(async payload => geometryBuild(payload as never) as never)
    const result = await runHeadless({
      doc: sketchAndExtrude(),
      steps: [setExtrudeDistance],
      featureDeltas: 'all',
      frames: 'all',
    })
    expect(result.outcome.ok).toBe(true)
    // The write-back kept the stored geometry, so there was nothing to settle.
    expect(kernel.solveLocally).toHaveBeenCalledTimes(1)
  })

  it('T4: a constraint that moves sketch geometry pays exactly two solves', async () => {
    vi.mocked(kernel.solveLocally).mockImplementation(async payload => geometryBuild(payload as never) as never)
    const result = await runHeadless({
      doc: sketchAndExtrude(),
      steps: [addHorizontal],
      featureDeltas: 'all',
      frames: 'all',
    })
    expect(result.outcome.ok).toBe(true)
    // The first solve moved the sketch, the second kept the rounded geometry.
    expect(kernel.solveLocally).toHaveBeenCalledTimes(2)
    expect(result.notes).toEqual([])
  })

  it('T6: a solve that never settles stops at the pass cap and notes it', async () => {
    vi.mocked(kernel.solveLocally).mockImplementation(async payload => {
      const features = (payload as { features?: StubSketch[] }).features ?? []
      const result: Record<string, unknown> = {}
      for (const feature of features) {
        if (feature.kind !== 'sketch') {
          result[feature.id] = { status: 'ok', body_id: `body_${feature.id}` }
          continue
        }
        // Offset the stored seed every pass, so the write-back always installs.
        const [x, y, z, w] = feature.initial?.l1 ?? [0, 0, 1, 0]
        result[feature.id] = {
          status: 'underconstrained',
          geometry: { l1: [x, y, z + 1e-3, w] },
        }
      }
      return {
        result,
        bodies: {},
        _build_state: { feature_order: features.map(feature => feature.id), checkpoints: {} },
      } as never
    })
    const result = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [addSketch('sk1')],
      featureDeltas: 'all',
      frames: 'all',
    })
    expect(kernel.solveLocally).toHaveBeenCalledTimes(SETTLE_PASSES)
    expect(result.solved).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.features).toEqual([])
    // A note, not a problem: the reply still reports the last pass it made.
    expect(result.notes).toEqual([{
      ids: ['sk1'],
      text: `solved sketch geometry did not settle on the document grid after ${SETTLE_PASSES} passes; `
        + 'this reply may differ from a re-solve of its docHash at the 1e-6 level',
    }])
  })
})
