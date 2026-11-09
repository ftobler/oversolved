// @vitest-environment node
//
// A part reply must describe the document its docHash names. The write-back
// stores solved sketch geometry rounded to the 1e-6 document grid, and an
// underconstrained sketch seeded from that rounded geometry solves somewhere
// else, so the reply used to describe the pre-write-back solve while a later
// measure of its docHash described the re-solve. The headless settle solves the
// stored document once more, so the reply and a measure of its hash agree
// exactly. Real kernel, gated like the other drive real suites.
//
// The shape is a closed outline: two lines, an arc from (2,1) back to (0,1)
// with centre (1,0.25) and radius 1.25, and the closing line. The arc's seed
// angles miss the line ends by about 1e-5, which is the offset the 1e-6 grid
// cannot keep: the write-back installs the rounded solve and a second solve
// from it lands elsewhere.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, emptyDriveDoc } from '../headlessOps'
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

// The arc's exact ends are (2,1) and (0,1): atan2(0.75, 1) and its supplement.
// Shifting both angles by 0.0005 degrees moves each endpoint by
// 1.25 * 0.0005 * pi / 180 = about 1.1e-5, inside neither the 1e-6 grid nor a
// single-rounding correction.
function outlineSteps(): ScriptStep[] {
  return [
    m({ type: 'add_sketch', featureId: 'sk1', label: 'Outline', plane: '@builtin_plane_front' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 2, 0], entityId: 'l1' }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [2, 0, 2, 1], entityId: 'l2' }),
    m({
      type: 'add_entity', featureId: 'sk1', kind: 'arc',
      params: [1, 0.25, 1.25, 36.870398, 143.129602], entityId: 'a1',
    }),
    m({ type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 1, 0, 0], entityId: 'l3' }),
    m({ type: 'add_extrude', featureId: 'ex1', label: 'Outline', sketchQuery: '$sk1', distance: 0.25, operation: 'new' }),
  ]
}

// The four joints, each tying two entity endpoints. No other constraint: the
// sketch stays underconstrained, which is what preserves the seed offset.
function jointSteps(): ScriptStep[] {
  const joints: Array<[string, string]> = [
    ['vertex:sk1:l1:end', 'vertex:sk1:l2:start'],
    ['vertex:sk1:l2:end', 'vertex:sk1:a1:start'],
    ['vertex:sk1:a1:end', 'vertex:sk1:l3:start'],
    ['vertex:sk1:l3:end', 'vertex:sk1:l1:start'],
  ]
  return joints.map(targets => m({ type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets }))
}

// Close the loop and remove every remaining degree of freedom: pin the origin,
// make the two straight sides axis-aligned, fix their lengths and the radius,
// and pin the free arc end absolutely with point_distance_x/y from the origin.
function fullyConstrainedSteps(): ScriptStep[] {
  return [
    ...jointSteps(),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'fixed', targets: ['vertex:sk1:l1:start'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:l1'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'vertical', targets: ['entity:sk1:l2'] }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 2 }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l2'], value: 1 }),
    m({ type: 'add_constraint', featureId: 'sk1', kind: 'radius', targets: ['entity:sk1:a1'], value: 1.25 }),
    m({
      type: 'add_constraint', featureId: 'sk1', kind: 'point_distance_x',
      targets: ['vertex:sk1:l1:start', 'vertex:sk1:a1:end'], value: 0,
    }),
    m({
      type: 'add_constraint', featureId: 'sk1', kind: 'point_distance_y',
      targets: ['vertex:sk1:l1:start', 'vertex:sk1:a1:end'], value: 1,
    }),
  ]
}

// The first run authors the outline open; the extrude then cannot close it.
async function openOutline(docId: string): Promise<PartDoc> {
  const first = await runHeadless({ doc: emptyDriveDoc(), steps: outlineSteps(), docId })
  expect(first.outcome.ok).toBe(true)
  expect(first.features.map(problem => problem.id)).toContain('ex1')
  return first.doc as PartDoc
}

const ex1Row = (result: Awaited<ReturnType<typeof runHeadless>>) => {
  const row = result.featureDeltas?.find(entry => entry.id === 'ex1')
  if (!row) throw new Error('the reply carried no ex1 delta row')
  return row
}

describe.skipIf(!ready)('a headless reply measures the stored document (real OCC + Rust solver)', () => {
  it('T1: an underconstrained authoring reply equals a measure of its docHash', async () => {
    const open = await openOutline('settle-t1-open')
    const second = await runHeadless({
      doc: open,
      steps: jointSteps(),
      docId: 'settle-t1-joints',
      featureDeltas: 'all',
    })
    expect(second.outcome.ok).toBe(true)
    expect(second.features).toEqual([])

    const measured = await measureHeadless(second.doc as PartDoc, { docId: 'settle-t1-measure' })
    expect(measured).not.toBeNull()
    const reply = ex1Row(second)
    // Exactly, not approximately: the reply and the measure are two solves of
    // the same stored document, so they cannot differ by a grid step.
    expect(reply.volume).toBe(measured!.measures.volume)
    expect(reply.bbox).toEqual(measured!.measures.bbox)
  }, 240_000)

  it('T2: a fully constrained authoring reply equals a measure of its docHash', async () => {
    const open = await openOutline('settle-t2-open')
    const second = await runHeadless({
      doc: open,
      steps: fullyConstrainedSteps(),
      docId: 'settle-t2-constrained',
      featureDeltas: 'all',
    })
    expect(second.outcome.ok).toBe(true)
    expect(second.features).toEqual([])
    // The extra dimensions remove the free motion the first pass was keeping.
    expect(second.part.solveOutcomes().sk1.status).toBe('fully_constrained')

    const measured = await measureHeadless(second.doc as PartDoc, { docId: 'settle-t2-measure' })
    expect(measured).not.toBeNull()
    const reply = ex1Row(second)
    expect(reply.volume).toBe(measured!.measures.volume)
    expect(reply.bbox).toEqual(measured!.measures.bbox)
  }, 240_000)

  it('T3: a reply describes the solved document and that document is a fixed point', async () => {
    const open = await openOutline('settle-t3-open')
    const second = await runHeadless({
      doc: open,
      steps: jointSteps(),
      docId: 'settle-t3-joints',
      featureDeltas: 'all',
    })
    expect(second.outcome.ok).toBe(true)
    const stored = second.doc as PartDoc
    const authored = ex1Row(second)

    const inspected = await runHeadless({
      doc: stored,
      steps: [],
      docId: 'settle-t3-inspect',
      featureDeltas: 'all',
    })
    expect(inspected.ok).toBe(true)
    const inspectedDoc = inspected.doc as PartDoc
    // The reply's numbers are the settle's, so they must describe the document
    // it hands back, exactly.
    const measured = await measureHeadless(inspectedDoc, { docId: 'settle-t3-measure' })
    expect(measured).not.toBeNull()
    const again = ex1Row(inspected)
    expect(again.volume).toBe(measured!.measures.volume)
    expect(again.bbox).toEqual(measured!.measures.bbox)

    // The stored seed for the underconstrained arc is one grid step off the
    // solve, so the first inspection is allowed to write that move ONCE (the
    // solver's half-step report; the old f32 envelope silently kept it). What
    // must hold is that the written document is then stable.
    const stable = await runHeadless({
      doc: inspectedDoc,
      steps: [],
      docId: 'settle-t3-stable',
      featureDeltas: 'all',
    })
    expect(stable.ok).toBe(true)
    expect(docHashOf(stable.doc as PartDoc)).toBe(docHashOf(inspectedDoc))
    const settled = ex1Row(stable)
    expect(settled.volume).toBe(authored.volume)
    expect(settled.bbox).toEqual(authored.bbox)
  }, 240_000)
})
