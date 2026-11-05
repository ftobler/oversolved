// @vitest-environment node
//
// A deferred recording applies several mutations before the solve that will
// bake them, so the document the entries chain from is authored. Version-3
// journal hashes cover the authored projection, so replay settles each entry
// and still reproduces exactly: the write-back no longer moves the recorded
// chain. A legacy version-2 payload, whose hashes cover the whole document,
// still warns about an entry applied before its settle and fails loudly at that
// boundary.
//
// Gated like the other Real suites: skips when OCC.js or the nodejs Rust build
// is absent. One session per process is the v1 contract, so the recording
// session is idle before the replay session starts, and the two use different
// doc ids so solveLocally's checkpoint cache switches documents.

import { createRequire } from 'node:module'
import { beforeAll, afterEach, describe, it, expect } from 'vitest'
import { setOccLoader } from '@/kernel/solveLocally'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { createHeadlessPart } from '../headlessPart'
import { CommandJournal, type ReproPayload } from '../journal'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import { seededIdSource } from '../seededIds'
import { setIdSource } from '@/utils/yamlMutations'
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
  ({ type: 'add_extrude', featureId, label: featureId, sketchQuery: '$sk1', distance: 5, operation: 'new' })

describe.skipIf(!oc || !solveBytes)('authored replay (real OCC + Rust solver)', () => {
  afterEach(() => {
    setIdSource(null)
  })

  beforeAll(() => {
    setOccLoader(loadOcc)
    setSketchSolver(loadSolver())
    setSketchTopology(loadTopology())
  })

  it('replays a deferred recording whose applies all precede the flush', async () => {
    const journal = new CommandJournal()
    const part = createHeadlessPart({ doc: sketchDoc(), journal })
    part.session.execute(addRect())
    await part.idle()
    // Two applies with no solve between them: the extrude and the sketch both
    // land on the authored document, and only the flush at the end bakes them.
    part.session.execute(addExtrude('ex1'))
    part.session.execute({ type: 'add_sketch', featureId: 'sk2', label: 'sketch 2' })
    await part.idle()

    const repro = journal.repro()
    expect(repro).not.toBeNull()
    expect(repro!.version).toBe(3)
    // A deferred request is not in flight, so no entry is unsettled; replay
    // settles each entry and the authored hashes chain across the write-back.
    expect(repro!.warnings).toEqual([])
    expect(repro!.journal.every(entry => entry.unsettled === undefined)).toBe(true)
    const recordedHash = docHashOf(part.getDoc())

    const fresh = createHeadlessPart({ doc: repro!.doc as PartDoc, docId: 'replay' })
    const outcome = await replayJournal(repro!, fresh.session, () => fresh.idle())
    expect(outcome.ok).toBe(true)
    expect(outcome.steps.every(step => step.ok)).toBe(true)
    expect(outcome.finalHash).toBe(recordedHash)
  }, 180_000)

  it('a legacy version-2 repro still diverges at an entry applied before its settle', async () => {
    // The pre-version-3 contract: hashes over the whole document. The extrude's
    // replay settle adds part_style, so the next entry's recorded before-hash no
    // longer matches and replay stops there.
    const doc = sketchDoc()
    const recorded = createHeadlessPart({ doc, docId: 'legacy-record' })
    // The rect mints inside the handler, so recording and replay must share the
    // same addressable source; the payload below names this seed.
    setIdSource(seededIdSource(0x5eed_0001))
    const entries: ReproPayload['journal'] = []
    const record = (payload: Mutation, kind: 'mutation' | 'batch' = 'mutation'): void => {
      const before = docHashOf(recorded.getDoc())
      recorded.session.execute(payload)
      entries.push({
        kind,
        payload,
        docHashBefore: before,
        docHashAfter: docHashOf(recorded.getDoc()),
        mintIndex: 0,
        at: 0,
      })
    }
    record(addRect())
    record(addExtrude('ex1'))
    record({ type: 'add_sketch', featureId: 'sk2', label: 'sketch 2' })
    const repro: ReproPayload = {
      kind: 'oversolved-repro',
      version: 2,
      docHash: docHashOf(doc),
      doc: structuredClone(doc),
      seed: 0x5eed_0001,
      warnings: [],
      journal: entries,
    }

    const fresh = createHeadlessPart({ doc: structuredClone(repro.doc) as PartDoc, docId: 'legacy-replay' })
    const outcome = await replayJournal(repro, fresh.session, () => fresh.idle())
    expect(outcome.ok).toBe(false)
    const failing = outcome.steps[outcome.steps.length - 1]
    expect(failing.index).toBe(2)
    expect(failing.ok).toBe(false)
    expect(failing.actualBeforeHash).not.toBe(failing.expectedBeforeHash)
  }, 180_000)
})
