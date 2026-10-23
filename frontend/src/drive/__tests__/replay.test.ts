// @vitest-environment node
//
// The repro shapes replay accepts. A version-1 payload keeps the old contract:
// one generation seed and an entry mint index, the shape every journal recorded
// before per-step seeds existed. A version-2 payload names each script step's
// seed, so a recording made after per-step seeding still reproduces and a step
// with several applies keeps one source instead of resetting it per entry.

import { describe, it, expect, afterEach } from 'vitest'
import { CommandJournal, JOURNAL_CAPACITY, createDriveJournal, journalSink } from '../journal'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import { driveSeedFor } from '../seededIds'
import { createDocSession, type DocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { setIdSource } from '@/utils/yamlMutations'
import { createHeadlessPart } from '../headlessPart'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'

afterEach(() => {
  setIdSource(null)
})

interface SessionHarness {
  session: DocSession
  cell: { current: PartDoc | null }
}

function makeSession(doc: PartDoc, journal?: CommandJournal, docId = 'doc-1'): SessionHarness {
  const cell: { current: PartDoc | null } = { current: doc }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const solve = createFakeSolveScheduler<PartDoc>()
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve,
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
    dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
    docId,
    ...(journal && { journal: journalSink(journal) }),
  })
  return { session, cell }
}

const sketchDoc = (): PartDoc => makeDoc(makeSketch('sk1'))

const addRect = (): Mutation =>
  ({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] })

const addNgon = (): Mutation =>
  ({ type: 'add_ngon', featureId: 'sk1', center: [20, 0], corner: [25, 0], sides: 6 })

const addExtrude = (featureId: string, distance: number): Mutation =>
  ({ type: 'add_extrude', featureId, label: featureId, sketchQuery: '$sk1', distance })

describe('repro version compatibility', () => {
  it('replays a version-1 payload under the old top-level seed semantics', async () => {
    // A recording from before per-step seeds: one generation seed, entries that
    // carry only a position in its sequence. add_rect mints inside the handler,
    // so only replaying that sequence reproduces the ids.
    const doc = sketchDoc()
    const seed = driveSeedFor(docHashOf(doc))
    const journal = new CommandJournal(JOURNAL_CAPACITY, Date.now, () => seed)
    const recorded = makeSession(doc, journal)
    recorded.session.execute(addRect())
    recorded.session.execute(addExtrude('ex1', 5))

    const repro = journal.repro()!
    expect(repro.version).toBe(1)
    expect(repro.seed).toBe(seed)
    expect(repro.journal).toHaveLength(2)
    expect(repro.journal.every(entry => entry.seed === undefined)).toBe(true)

    const fresh = makeSession(structuredClone(repro.doc) as PartDoc)
    const outcome = await replayJournal(repro, fresh.session)
    expect(outcome.ok).toBe(true)
    expect(outcome.finalHash).toBe(docHashOf(recorded.cell.current))
  })

  it('round-trips a version-2 step-seeded recording', async () => {
    const journal = createDriveJournal({ version: 1, kind: 'part', features: [] } as PartDoc)
    const part = createHeadlessPart({ doc: { version: 1, kind: 'part', features: [] } as PartDoc, docId: 'seed-record', journal })
    const outcome = await part.run([
      { mutation: { type: 'add_sketch', featureId: 'sk1', label: 'Rectangle', plane: '@builtin_plane_front' } },
      { mutation: addRect() },
      { mutation: addExtrude('ex1', 5) },
    ])
    expect(outcome.ok).toBe(true)

    const repro = journal.repro()!
    expect(repro.version).toBe(2)
    expect(repro.journal).toHaveLength(3)
    expect(repro.journal.every(entry => typeof entry.seed === 'number')).toBe(true)
    const recordedHash = docHashOf(part.getDoc())

    const fresh = createHeadlessPart({ doc: structuredClone(repro.doc) as PartDoc, docId: 'seed-replay' })
    const replay = await replayJournal(repro, fresh.session, () => fresh.idle())
    expect(replay.ok).toBe(true)
    expect(replay.finalHash).toBe(recordedHash)
  })

  it('keeps every entry of one step on the step seed and its sequence', async () => {
    // A step may dispatch several mutations; they are one step's work, so
    // replay must not restart the generator between their entries.
    const journal = new CommandJournal(JOURNAL_CAPACITY, Date.now, () => 999)
    const recorded = makeSession(sketchDoc(), journal)
    journal.beginStep(0x1234_5678)
    recorded.session.execute(addRect())
    recorded.session.execute(addNgon())

    const repro = journal.repro()!
    expect(repro.version).toBe(2)
    expect(repro.journal.map(entry => entry.seed)).toEqual([0x1234_5678, 0x1234_5678])
    expect(repro.journal[1].mintIndex).toBeGreaterThan(repro.journal[0].mintIndex)

    const fresh = makeSession(structuredClone(repro.doc) as PartDoc)
    const replay = await replayJournal(repro, fresh.session)
    expect(replay.ok).toBe(true)
    expect(replay.finalHash).toBe(docHashOf(recorded.cell.current))
  })
})
