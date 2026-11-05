// @vitest-environment node
//
// The deferred solve, through the real kernel: one `run` call solves once at
// the end (plus a baseline solve when the reply filters ask for one), so a
// long script pays one tessellation and write-back, not one per step. Chunking
// the same script into single-step calls must answer the same way, which pins
// the authored seed and the authored journal hashes: the authored document a
// step reads mid-call and the baked one a fresh call starts from hash the same.
// Gated like the other drive suites: skips when OCC.js or the Rust node build
// is absent.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
import { createDriveJournal } from '../journal'
import { replayJournal } from '../replay'
import { createHeadlessPart } from '../headlessPart'
import { docHashOf } from '../docHash'
import type { ScriptStep } from '../scriptRunner'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

// Two bodies built by six accepted steps, the shape a caller chains on.
function twoBodyScript(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', label: 'Plate', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 6] }),
    m({ type: 'add_extrude', featureId: 'ex1', label: 'Plate', sketchQuery: '$sk1', distance: 5, operation: 'new' }),
    m({ type: 'add_sketch', featureId: 'sk2', label: 'Post', plane: '@builtin_plane_front' }),
    m({ type: 'add_rect', featureId: 'sk2', p0: [20, 0], p1: [25, 5] }),
    m({ type: 'add_extrude', featureId: 'ex2', label: 'Post', sketchQuery: '$sk2', distance: 2, operation: 'new' }),
  ]
}

// `run` replies filtered to nothing: both opt-ins skip the baseline solve and
// exercise the final solve's whole-map answer.
async function runWhole(steps: ScriptStep[], docId: string, doc: PartDoc = emptyDriveDoc()) {
  return runHeadless({ doc, steps, docId, featureDeltas: 'all', frames: 'all' })
}

// The same script as single-step calls, each chained by the previous reply's
// doc hash exactly as a client recovers from a timeout.
async function runOnePerCall(steps: ScriptStep[], docId: string) {
  let doc = emptyDriveDoc()
  let last: Awaited<ReturnType<typeof runWhole>> | null = null
  for (const [index, step] of steps.entries()) {
    last = await runWhole([step], `${docId}-${index}`, doc)
    expect(last.outcome.ok).toBe(true)
    doc = last.doc as PartDoc
  }
  if (!last) throw new Error('the script had no steps')
  return last
}

describe.skipIf(!ready)('one deferred solve per run (real OCC + Rust solver)', () => {
  it('one call and single-step calls answer the same volume, deltas and features', async () => {
    const steps = twoBodyScript()
    const once = await runWhole(steps, 'batch-once')
    const singles = await runOnePerCall(steps, 'batch-singles')

    expect(once.outcome.ok).toBe(true)
    expect(once.solve.generation).toBe(1)
    expect(singles.solve.generation).toBe(1)
    expect(once.features).toEqual([])
    expect(singles.features).toEqual([])
    expect(singles.featureDeltas).toEqual(once.featureDeltas)
    expect(singles.frames).toEqual(once.frames)

    const onceMeasured = await measureHeadless(once.doc as PartDoc, { docId: 'batch-once-measure' })
    const singlesMeasured = await measureHeadless(singles.doc as PartDoc, { docId: 'batch-singles-measure' })
    expect(onceMeasured!.ok).toBe(true)
    expect(singlesMeasured!.ok).toBe(true)
    expect(onceMeasured!.measures.volume).toBeCloseTo(10 * 6 * 5 + 5 * 5 * 2, 6)
    expect(singlesMeasured!.measures.volume).toBeCloseTo(onceMeasured!.measures.volume, 6)
  }, 240_000)

  it('about thirty add_rect steps into one sketch solve once and keep every entity', async () => {
    const rects: ScriptStep[] = []
    for (let i = 0; i < 30; i++) {
      const x = (i % 6) * 2
      const y = Math.floor(i / 6) * 2
      rects.push(m({ type: 'add_rect', featureId: 'sk1', p0: [x, y], p1: [x + 1, y + 1] }))
    }
    const steps: ScriptStep[] = [
      m({ type: 'add_sketch', featureId: 'sk1', label: 'Cells', plane: '@builtin_plane_front' }),
      ...rects,
      m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1, operation: 'new' }),
    ]
    const once = await runWhole(steps, 'batch-cells')
    expect(once.outcome.ok).toBe(true)
    expect(once.outcome.steps.every(step => step.ok)).toBe(true)
    // The generation counts solves, not steps: one final solve for 32 steps.
    expect(once.solve.generation).toBe(1)
    expect(once.outcome.steps.slice(1, 31).flatMap(step => step.createdIds)).toHaveLength(30 * 4)
    const sketch = once.doc?.features?.find(feature => feature.id === 'sk1') as SketchFeature
    expect(sketch.entities).toHaveLength(30 * 4)

    const measured = await measureHeadless(once.doc as PartDoc, { docId: 'batch-cells-measure' })
    expect(measured!.measures.volume).toBeCloseTo(30, 6)
  }, 120_000)

  it('a repro from a deferred run replays entry by entry and ends on the reply hash', async () => {
    const start = emptyDriveDoc()
    const recorded = createDriveJournal(start)
    const part = createHeadlessPart({ doc: start, docId: 'batch-repro-record', journal: recorded })
    const outcome = await part.run(twoBodyScript())
    expect(outcome.ok).toBe(true)
    const repro = recorded.repro()!
    expect(repro.version).toBe(3)
    const replyHash = docHashOf(part.getDoc() as PartDoc)

    const fresh = createHeadlessPart({ doc: structuredClone(repro.doc) as PartDoc, docId: 'batch-repro-replay' })
    const replay = await replayJournal(repro, fresh.session, () => fresh.idle())
    expect(replay.ok).toBe(true)
    expect(replay.steps.every(step => step.ok)).toBe(true)
    expect(replay.finalHash).toBe(replyHash)
  }, 240_000)

  it('mirror_entities reads the same geometry deferred and one step per call', async () => {
    // A constrained sketch (the top line already satisfies its horizontal
    // constraint, so the solve does not move it) mirrored about its own axis
    // line. Under deferral the handler reads authored `initial`; a one-step
    // call chain reads the baked one. Both must mirror the same geometry.
    const steps: ScriptStep[] = [
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, -3, 0, 3], entityId: 'ax' }),
      m({ type: 'toggle_construction', targets: ['entity:sk1:ax'] }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 2, 3, 2], entityId: 'top' }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [3, 2, 3, -2], entityId: 'side' }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [3, -2, 0, -2], entityId: 'bottom' }),
      m({ type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:top'] }),
      m({ type: 'mirror_entities', featureId: 'sk1', sourceIds: ['top', 'side', 'bottom'], line: 'ax' }),
      m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, operation: 'new' }),
    ]
    const once = await runWhole(steps, 'batch-mirror')
    const singles = await runOnePerCall(steps, 'batch-mirror-singles')
    expect(once.features).toEqual([])
    expect(singles.features).toEqual([])

    const geometry = (doc: PartDoc | null): Record<string, number[]> => {
      const sketch = doc?.features?.find(feature => feature.id === 'sk1')
      return sketch?.kind === 'sketch' ? sketch.initial ?? {} : {}
    }
    expect(geometry(singles.doc)).toEqual(geometry(once.doc))
    expect(Object.keys(geometry(once.doc))).toHaveLength(7)

    const onceMeasured = await measureHeadless(once.doc as PartDoc, { docId: 'batch-mirror-measure' })
    const singlesMeasured = await measureHeadless(singles.doc as PartDoc, { docId: 'batch-mirror-singles-measure' })
    expect(onceMeasured!.measures.volume).toBeCloseTo(120, 6)
    expect(singlesMeasured!.measures.volume).toBeCloseTo(onceMeasured!.measures.volume, 6)
  }, 240_000)
})
