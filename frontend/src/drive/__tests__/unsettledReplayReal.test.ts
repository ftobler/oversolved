// @vitest-environment node
//
// The unsettled-entry policy on the real kernel. A browser recording can apply
// a mutation while the previous solve is still in flight, so that entry's
// before-doc is authored while a replay settles each step and reaches the baked
// state: the repro must warn about such entries and replay must fail loudly at
// the first divergence. A recording that waits for each solve is settled and
// replays exactly.
//
// Gated like the other Real suites: skips when OCC.js or the nodejs Rust build
// is absent. One session per process is the v1 contract, so the recording
// session is idle before the replay session starts, and the two use different
// doc ids so solveLocally's checkpoint cache switches documents.

import { createRequire } from 'node:module'
import { beforeAll, describe, it, expect } from 'vitest'
import { setOccLoader } from '@/kernel/solveLocally'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { createHeadlessPart } from '../headlessPart'
import { CommandJournal } from '../journal'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import type { PartDoc, Mutation } from '@/types/cad'

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

function sketchDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front' }] }
}

const addRect = (): Mutation =>
  ({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] })

const addExtrude = (featureId: string): Mutation =>
  ({ type: 'add_extrude', featureId, label: featureId, sketchQuery: '$sk1', distance: 5 })

describe.skipIf(!oc || !solveBytes)('unsettled replay (real OCC + Rust solver)', () => {
  beforeAll(() => {
    setOccLoader(loadOcc)
    setSketchSolver(loadSolver())
    setSketchTopology(loadTopology())
  })

  it('warns about an unsettled entry and fails loudly at its boundary', async () => {
    const journal = new CommandJournal()
    const part = createHeadlessPart({ doc: sketchDoc(), journal })
    part.session.execute(addRect())
    await part.idle()
    // The extrude's solve writes part_style back when it lands, so the next
    // apply, fired before that solve settles, records against the authored doc
    // while replay settles and reaches the part_style-carrying one.
    part.session.execute(addExtrude('ex1'))
    part.session.execute({ type: 'add_sketch', featureId: 'sk2', label: 'sketch 2' })
    await part.idle()

    const repro = journal.repro()
    expect(repro).not.toBeNull()
    expect(repro!.journal[0].unsettled).toBeUndefined()
    expect(repro!.journal[1].unsettled).toBeUndefined()
    expect(repro!.journal[2].unsettled).toBe(true)
    expect(repro!.warnings).toHaveLength(1)
    expect(repro!.warnings[0]).toContain('entry 2')
    expect(repro!.warnings[0]).toContain('add sketch 2')

    const fresh = createHeadlessPart({ doc: repro!.doc as PartDoc, docId: 'replay' })
    const outcome = await replayJournal(repro!, fresh.session, () => fresh.idle())
    expect(outcome.ok).toBe(false)
    const failing = outcome.steps[outcome.steps.length - 1]
    expect(failing.index).toBe(2)
    expect(failing.ok).toBe(false)
    expect(failing.actualBeforeHash).not.toBe(failing.expectedBeforeHash)
  }, 180_000)

  it('replays a settled recording exactly', async () => {
    const journal = new CommandJournal()
    const part = createHeadlessPart({ doc: sketchDoc(), journal })
    part.session.execute(addRect())
    await part.idle()
    part.session.execute(addExtrude('ex1'))
    await part.idle()

    const repro = journal.repro()
    expect(repro).not.toBeNull()
    expect(repro!.warnings).toEqual([])
    expect(repro!.journal.every(entry => entry.unsettled === undefined)).toBe(true)
    const recordedHash = docHashOf(part.getDoc())

    const fresh = createHeadlessPart({ doc: repro!.doc as PartDoc, docId: 'replay' })
    const outcome = await replayJournal(repro!, fresh.session, () => fresh.idle())
    expect(outcome.ok).toBe(true)
    expect(outcome.finalHash).toBe(recordedHash)
  }, 180_000)
})
