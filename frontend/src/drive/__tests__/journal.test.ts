// @vitest-environment node
//
// The journal records at the session mutation seam, so these suites drive a
// real DocSession (fake scheduler, no kernel) and read the ring the module
// sink fills. Replay is exercised end to end: a seeded recording of drawing
// and feature-add mutations replays on a fresh session to the same hash.

import { describe, it, expect, afterEach } from 'vitest'
import { CommandJournal, JOURNAL_CAPACITY, journalSink, type ReproPayload } from '../journal'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import { seededIdSource } from '../seededIds'
import { createDocSession, type DocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { setIdSource } from '@/utils/yamlMutations'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import type { SessionJournalChange } from '@/session/DocSession'

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
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve: createFakeSolveScheduler<PartDoc>(),
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
    dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
    docId,
    ...(journal && { journal: journalSink(journal) }),
  })
  return { session, cell }
}

const sketchDoc = (): PartDoc => makeDoc(makeSketch('sk1'))

const addExtrude = (featureId: string, distance: number): Mutation =>
  ({ type: 'add_extrude', featureId, label: featureId, sketchQuery: '$sk1', distance })

// A direct sink change for the ring's own unit tests, with docs chosen so the
// before and after hashes differ (the label rides in the document).
function change(overrides: Partial<SessionJournalChange> = {}): SessionJournalChange {
  const beforeDoc = makeDoc(makeSketch('sk1', { label: 'before' }))
  const afterDoc = makeDoc(makeSketch('sk1', { label: 'after' }))
  return {
    docId: 'doc-1',
    kind: 'mutation',
    payload: { type: 'toggle_plane_visibility' },
    label: 'toggle plane visibility',
    beforeDoc,
    afterDoc,
    ...overrides,
  }
}

describe('CommandJournal', () => {
  it('records a session mutation with its payload, label and sync hashes', () => {
    const journal = new CommandJournal(JOURNAL_CAPACITY, () => 1234)
    const before = sketchDoc()
    const after = structuredClone(before)
    after.features![0].label = 'renamed'
    journal.recordApplied(change({ beforeDoc: before, afterDoc: after }))
    expect(journal.size()).toBe(1)
    const [entry] = journal.entries()
    expect(entry.kind).toBe('mutation')
    expect(entry.payload).toEqual({ type: 'toggle_plane_visibility' })
    expect(entry.label).toBe('toggle plane visibility')
    expect(entry.docHashBefore).toBe(docHashOf(before))
    expect(entry.docHashAfter).toBe(docHashOf(after))
    expect(entry.at).toBe(1234)
  })

  it('skips a no-op apply and keeps a batch payload as an array', () => {
    const journal = new CommandJournal()
    const doc = sketchDoc()
    journal.recordApplied(change({ beforeDoc: doc, afterDoc: structuredClone(doc) }))
    expect(journal.size()).toBe(0)
    const after = structuredClone(doc)
    after.features![0].label = 'x'
    journal.recordApplied(change({
      kind: 'batch',
      payload: [addExtrude('ex1', 1), addExtrude('ex2', 2)],
      beforeDoc: doc,
      afterDoc: after,
    }))
    expect(journal.entries()[0].kind).toBe('batch')
    expect(journal.entries()[0].payload).toHaveLength(2)
  })

  it('caps the ring and restarts the generation so the suffix stays replayable', () => {
    const journal = new CommandJournal(2)
    const docs = [0, 1, 2, 3].map(n => makeDoc(makeSketch('sk1', { label: `v${n}` })))
    for (let i = 0; i < 3; i++) {
      journal.recordApplied(change({ beforeDoc: docs[i], afterDoc: docs[i + 1] }))
    }
    // The third record overflowed the two-slot ring: the generation restarted
    // with it, and its baseline is the doc it read (v2), not the original.
    expect(journal.size()).toBe(1)
    const repro = journal.repro()
    expect(repro).not.toBeNull()
    expect(repro!.doc).toEqual(docs[2])
    expect(repro!.docHash).toBe(docHashOf(docs[2]))
  })

  it('is empty until a generation with a baseline lands, and clears back to empty', () => {
    const journal = new CommandJournal()
    expect(journal.repro()).toBeNull()
    journal.clear()
    expect(journal.repro()).toBeNull()
  })

  it('hands out detached copies of the baseline and the entries', () => {
    const journal = new CommandJournal()
    const before = makeDoc(makeSketch('sk1', { label: 'before' }))
    const after = structuredClone(before)
    after.features![0].label = 'after'
    journal.recordApplied(change({ beforeDoc: before, afterDoc: after }))
    const repro = journal.repro()!
    ;(repro.doc as PartDoc).features![0].label = 'tampered'
    expect((journal.repro()!.doc as PartDoc).features![0].label).toBe('before')
    const entries = journal.entries()
    entries[0].label = 'tampered'
    expect(journal.entries()[0].label).toBe('toggle plane visibility')
    expect(JSON.parse(JSON.stringify(repro))).toEqual(repro)
  })

  it('resets its generation when a record arrives for another document', () => {
    const journal = new CommandJournal()
    journal.reset('doc-a')
    expect(journal.docId()).toBe('doc-a')
    const afterA = structuredClone(sketchDoc())
    afterA.features![0].label = 'a'
    journal.recordApplied(change({ docId: 'doc-a', beforeDoc: sketchDoc(), afterDoc: afterA }))
    expect(journal.size()).toBe(1)
    const beforeB = sketchDoc()
    const afterB = structuredClone(beforeB)
    afterB.features![0].label = 'b'
    journal.recordApplied(change({ docId: 'doc-b', beforeDoc: beforeB, afterDoc: afterB }))
    expect(journal.docId()).toBe('doc-b')
    expect(journal.size()).toBe(1)
    expect(journal.repro()!.doc).toEqual(beforeB)
  })
})

describe('the session seam', () => {
  it('records execute as a mutation and executeGroup as one batch', () => {
    const journal = new CommandJournal()
    const { session } = makeSession(sketchDoc(), journal)
    session.execute(addExtrude('ex1', 1))
    expect(journal.size()).toBe(1)
    expect(journal.entries()[0].kind).toBe('mutation')
    expect(journal.entries()[0].payload).toMatchObject({ type: 'add_extrude', featureId: 'ex1' })
    session.executeGroup([addExtrude('ex2', 2), addExtrude('ex3', 3)])
    expect(journal.size()).toBe(2)
    expect(journal.entries()[1].kind).toBe('batch')
    expect(journal.entries()[1].payload).toHaveLength(2)
  })

  it('records gesture frames and a cancelled gesture clears them', () => {
    const journal = new CommandJournal()
    const { session } = makeSession(sketchDoc(), journal)
    const opened = session.begin('gesture')
    expect(opened.ok).toBe(true)
    session.execute({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [0, 0], entityId: 'p1' })
    session.execute({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 1], entityId: 'p2' })
    expect(journal.size()).toBe(2)
    if (opened.ok) session.cancel(opened.id)
    expect(journal.size()).toBe(0)
  })

  it('restarts the suffix on undo, so a repro is never a torn history', () => {
    const journal = new CommandJournal()
    const { session } = makeSession(sketchDoc(), journal)
    session.execute(addExtrude('ex1', 1))
    expect(journal.size()).toBe(1)
    session.undo()
    expect(journal.repro()).toBeNull()
    session.execute(addExtrude('ex2', 2))
    expect(journal.size()).toBe(1)
    expect(journal.entries()[0].payload).toMatchObject({ featureId: 'ex2' })
  })

  it('records nothing for a no-op apply', () => {
    const journal = new CommandJournal()
    const { session } = makeSession(sketchDoc(), journal)
    session.execute({ type: 'delete_feature', featureId: 'missing' })
    expect(journal.repro()).toBeNull()
  })
})

describe('replayJournal', () => {
  it('replays seeded drawing and feature-add mutations to the same document hash', async () => {
    // Recording under the seeded source is what makes the internally minted
    // ids (add_rect) reproducible; replay installs a fresh one of its own.
    setIdSource(seededIdSource())
    const journal = new CommandJournal()
    const recorded = makeSession(sketchDoc(), journal)
    recorded.session.execute({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] })
    recorded.session.execute(addExtrude('ex1', 5))
    const repro = journal.repro()
    expect(repro).not.toBeNull()
    const expectedFinal = docHashOf(recorded.cell.current!)

    const fresh = makeSession(structuredClone(repro!.doc) as PartDoc, undefined, 'doc-1')
    // No settle here: the fake scheduler never writes back, and the suite
    // pins the synchronous hashes. The CLI smoke covers the settle path.
    const outcome = await replayJournal(repro!, fresh.session)
    expect(outcome.ok).toBe(true)
    expect(outcome.baselineHash).toBe(repro!.docHash)
    expect(outcome.steps).toHaveLength(2)
    expect(outcome.steps[0].kind).toBe('mutation')
    expect(outcome.finalHash).toBe(expectedFinal)
    expect(fresh.cell.current?.features?.some(f => f.id === 'ex1')).toBe(true)
  })

  it('replays a batch entry through the group funnel', async () => {
    const journal = new CommandJournal()
    const recorded = makeSession(sketchDoc(), journal)
    recorded.session.executeGroup([addExtrude('ex1', 1), addExtrude('ex2', 2)])
    const repro = journal.repro()!
    expect(repro.journal[0].kind).toBe('batch')

    const fresh = makeSession(structuredClone(repro.doc) as PartDoc, undefined, 'doc-1')
    const outcome = await replayJournal(repro, fresh.session)
    expect(outcome.ok).toBe(true)
    expect(outcome.steps[0].kind).toBe('batch')
    expect(fresh.cell.current?.features?.map(f => f.id)).toEqual(['sk1', 'ex1', 'ex2'])
  })

  it('stops with both hashes when a step lands elsewhere than the journal recorded', async () => {
    const journal = new CommandJournal()
    const recorded = makeSession(sketchDoc(), journal)
    recorded.session.execute(addExtrude('ex1', 1))
    const repro = journal.repro()!
    const tampered: ReproPayload = structuredClone(repro)
    tampered.journal[0].docHashAfter = 'not-the-real-hash'
    const fresh = makeSession(structuredClone(repro.doc) as PartDoc, undefined, 'doc-1')
    const outcome = await replayJournal(tampered, fresh.session)
    expect(outcome.ok).toBe(false)
    expect(outcome.steps).toHaveLength(1)
    expect(outcome.steps[0].ok).toBe(false)
    expect(outcome.steps[0].expectedHash).toBe('not-the-real-hash')
    expect(outcome.steps[0].actualHash).toBe(docHashOf(fresh.cell.current))
  })

  it('rejects a baseline that does not match the repro before executing anything', async () => {
    const journal = new CommandJournal()
    const recorded = makeSession(sketchDoc(), journal)
    recorded.session.execute(addExtrude('ex1', 1))
    const repro = journal.repro()!
    const empty = makeDoc()
    const fresh = makeSession(empty, undefined, 'doc-1')
    const outcome = await replayJournal(repro, fresh.session)
    expect(outcome.ok).toBe(false)
    expect(outcome.baselineHash).toBe(docHashOf(empty))
    expect(outcome.steps).toEqual([])
  })

  it('reports a failed mutation Result with its error and stops', async () => {
    const journal = new CommandJournal()
    const recorded = makeSession(sketchDoc(), journal)
    recorded.session.execute(addExtrude('ex1', 1))
    const repro = journal.repro()!
    const fresh = makeSession(structuredClone(repro.doc) as PartDoc, undefined, 'doc-1')
    const outcome = await replayJournal(repro, {
      getDoc: () => fresh.session.getDoc(),
      execute: () => ({ ok: false, code: 'unknown-mutation', message: 'gone' }),
      executeGroup: () => ({ ok: false, code: 'unknown-mutation', message: 'gone' }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error).toEqual({ code: 'unknown-mutation', message: 'gone' })
  })

  it('starts a fresh replayable suffix after a document switch', async () => {
    const journal = new CommandJournal()
    const a = makeSession(sketchDoc(), journal, 'doc-a')
    a.session.execute(addExtrude('exA', 1))
    expect(journal.repro()).not.toBeNull()

    const b = makeSession(sketchDoc(), journal, 'doc-b')
    b.session.execute(addExtrude('exB', 2))
    const repro = journal.repro()!
    // The switch reset the ring: only doc-b's mutation remains, on doc-b's own
    // baseline, so a cross-document journal cannot be produced.
    expect(repro.journal).toHaveLength(1)
    expect(repro.journal[0].payload).toMatchObject({ featureId: 'exB' })
    expect((repro.doc as PartDoc).features?.some(f => f.id === 'exA')).toBe(false)

    const fresh = makeSession(structuredClone(repro.doc) as PartDoc, undefined, 'doc-b')
    const outcome = await replayJournal(repro, fresh.session)
    expect(outcome.ok).toBe(true)
  })
})
