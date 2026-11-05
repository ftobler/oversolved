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

  it('a docked dimension materializes the same contact deferred and one step per call', async () => {
    // Two overlapping circles made tangent by the solve: the authored contact
    // and the solved one differ, so the dock must read the settled params. The
    // tangent host id is minted under the step seed, so a discovery run of the
    // prefix names the same host in the full script.
    const prefix: ScriptStep[] = [
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [0, 0, 5], entityId: 'cA' }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'circle', params: [12, 0, 5], entityId: 'cB' }),
      m({ type: 'add_constraint', featureId: 'sk1', kind: 'tangent', targets: ['entity:sk1:cA', 'entity:sk1:cB'] }),
    ]
    const discovered = await runWhole(prefix, 'batch-dock-discover')
    const discoveredSketch = discovered.doc?.features?.find(feature => feature.id === 'sk1')
    const host = discoveredSketch?.kind === 'sketch'
      ? discoveredSketch.constraints?.find(constraint => constraint.kind === 'tangent')?.id
      : undefined
    if (host === undefined) throw new Error('the tangent constraint minted no host id')

    const steps: ScriptStep[] = [
      ...prefix,
      m({
        type: 'add_constraint', featureId: 'sk1', kind: 'coincident',
        targets: ['vertex:sk1:free:xy', `dock:sk1:${host}`],
      }),
    ]
    const once = await runWhole(steps, 'batch-dock')
    const singles = await runOnePerCall(steps, 'batch-dock-singles')
    expect(once.features).toEqual([])
    expect(singles.features).toEqual([])

    const sketchOf = (doc: PartDoc | null) => doc?.features?.find(feature => feature.id === 'sk1')
    const onceSketch = sketchOf(once.doc)
    const singlesSketch = sketchOf(singles.doc)
    expect(onceSketch?.kind === 'sketch' ? onceSketch.initial : null)
      .toEqual(singlesSketch?.kind === 'sketch' ? singlesSketch.initial : null)
    expect(onceSketch?.kind === 'sketch' ? onceSketch.constraints : null)
      .toEqual(singlesSketch?.kind === 'sketch' ? singlesSketch.constraints : null)

    // The dock point exists and both runs put it at the same contact.
    if (onceSketch?.kind !== 'sketch') throw new Error('the run lost the sketch')
    const point = onceSketch.entities?.find(entity => entity.kind === 'point')
    expect(point).toBeDefined()
    expect(onceSketch.initial?.[point!.id]).toHaveLength(2)
  }, 240_000)

  it('mirror_entities reads the same settled geometry deferred and one step per call', async () => {
    // The length constraint moves the top line, so the authored params and the
    // solved ones differ. A deferred mirror must flush first, exactly as the
    // one-step-per-call chain does after each call; otherwise the one-call
    // clone is mirrored from the stale authored length.
    const steps: ScriptStep[] = [
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, -3, 0, 3], entityId: 'ax' }),
      m({ type: 'toggle_construction', targets: ['entity:sk1:ax'] }),
      m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 2, 4, 2], entityId: 'top' }),
      m({ type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:top'], value: 10 }),
      m({ type: 'mirror_entities', featureId: 'sk1', sourceIds: ['top'], line: 'ax' }),
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

    const initial = geometry(once.doc)
    const clone = Object.entries(initial).find(([id]) => id !== 'ax' && id !== 'top')
    expect(clone).toBeDefined()
    const [x0, y0, x1, y1] = clone![1]
    // The clone was mirrored after the solve moved `top` to length 10, so it is
    // ten long; mirroring the stale authored length 4 would leave it at 4.
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(10, 6)
  }, 240_000)
})
