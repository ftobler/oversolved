// @vitest-environment node
//
// The journal records at the session mutation seam, so these suites drive a
// real DocSession (fake scheduler, no kernel) and read the ring the module
// sink fills. Replay is exercised end to end: a browser-context recording of
// drawing and feature-add mutations (internally minted ids included) replays
// on a fresh session from the payload alone to the same hash.

import { describe, it, expect, afterEach } from 'vitest'
import { CommandJournal, JOURNAL_CAPACITY, journalSink, type ReproPayload } from '../journal'
import { replayJournal } from '../replay'
import { docHashOf } from '../docHash'
import { createDocSession, type DocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { setIdSource, randomId } from '@/utils/yamlMutations'
import { freshEntityIds, mintEntityId, uniqueConstraintId } from '@/utils/yamlMutations/helpers'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import type { SessionJournalChange } from '@/session/DocSession'

afterEach(() => {
  setIdSource(null)
})

interface SessionHarness {
  session: DocSession
  cell: { current: PartDoc | null }
  solve: ReturnType<typeof createFakeSolveScheduler<PartDoc>>
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
  return { session, cell, solve }
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
    unsettled: false,
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

  it('draws a different seed for each generation', () => {
    // An injected source makes the assertion deterministic; the default draws
    // the same way from crypto.
    let drawn = 0
    const journal = new CommandJournal(JOURNAL_CAPACITY, Date.now, () => ++drawn)
    const first = sketchDoc()
    const firstAfter = structuredClone(first)
    firstAfter.features![0].label = 'first'
    journal.recordApplied(change({ beforeDoc: first, afterDoc: firstAfter }))
    const firstSeed = journal.repro()!.seed
    journal.reset('doc-1')
    const second = sketchDoc()
    const secondAfter = structuredClone(second)
    secondAfter.features![0].label = 'second'
    journal.recordApplied(change({ beforeDoc: second, afterDoc: secondAfter }))
    const secondSeed = journal.repro()!.seed
    expect(firstSeed).toBe(1)
    expect(secondSeed).toBe(2)
    expect(secondSeed).not.toBe(firstSeed)
    // The default source draws an integer seed from crypto.
    const cryptoJournal = new CommandJournal()
    cryptoJournal.recordApplied(change())
    expect(Number.isInteger(cryptoJournal.repro()!.seed)).toBe(true)
  })

  it('routes every mint helper through the installed source', () => {
    let n = 0
    setIdSource(() => `id-${++n}`)
    expect(randomId(12)).toBe('id-1')
    expect(freshEntityIds([], 2)).toEqual(['id-2', 'id-3'])
    expect(mintEntityId([])).toBe('id-4')
    // A supplied id is taken verbatim, never re-rolled.
    expect(mintEntityId([], 'given')).toBe('given')
    expect(uniqueConstraintId([], 'length')).toBe('c_length_id-5')
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

  it('marks entries applied while a solve was pending and warns in the repro', () => {
    const journal = new CommandJournal()
    const { session, solve } = makeSession(sketchDoc(), journal)
    session.execute(addExtrude('ex1', 1))
    session.execute(addExtrude('ex2', 2))
    const repro = journal.repro()!
    expect(repro.journal[0].unsettled).toBeUndefined()
    expect(repro.journal[1].unsettled).toBe(true)
    expect(repro.warnings).toHaveLength(1)
    expect(repro.warnings[0]).toContain('entry 1')
    expect(repro.warnings[0]).toContain('add extrude ex2')
    // A recording that waits for its solve is settled and carries no warning.
    solve.flush()
    journal.reset('doc-1')
    session.execute(addExtrude('ex3', 3))
    const settled = journal.repro()!
    expect(settled.journal).toHaveLength(1)
    expect(settled.journal[0].unsettled).toBeUndefined()
    expect(settled.warnings).toEqual([])
  })
})

describe('replayJournal', () => {
  it('replays a browser-context drawing and feature-add journal from the payload alone', async () => {
    // No source is installed: this is the browser's context. The journal draws
    // a crypto seed when its generation opens, installs a seeded source before
    // the handlers run, and puts the seed in the payload, so add_rect's
    // internally minted entities and constraints reproduce on replay.
    const journal = new CommandJournal()
    const recorded = makeSession(sketchDoc(), journal)
    recorded.session.execute({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] })
    recorded.session.execute(addExtrude('ex1', 5))
    const repro = journal.repro()
    expect(repro).not.toBeNull()
    expect(typeof repro!.seed).toBe('number')
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

  it('replays the same payload twice to the same hash', async () => {
    const journal = new CommandJournal()
    const recorded = makeSession(sketchDoc(), journal)
    recorded.session.execute({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] })
    const repro = journal.repro()!

    const first = await replayJournal(repro, makeSession(structuredClone(repro.doc) as PartDoc, undefined, 'doc-1').session)
    const second = await replayJournal(repro, makeSession(structuredClone(repro.doc) as PartDoc, undefined, 'doc-1').session)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(second.finalHash).toBe(first.finalHash)
  })

  it('seeks past ids the recording minted outside the session', async () => {
    // The UI mints feature ids between applies (Part.tsx does); replay never
    // runs that code, so the recorded source position is what keeps the next
    // handler's internally minted ids aligned.
    const journal = new CommandJournal()
    const recorded = makeSession(sketchDoc(), journal)
    recorded.session.execute(addExtrude('ex0', 1))
    randomId(18)
    recorded.session.execute({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] })
    const repro = journal.repro()!
    expect(repro.journal[1].mintIndex).toBeGreaterThan(repro.journal[0].mintIndex)

    const fresh = makeSession(structuredClone(repro.doc) as PartDoc, undefined, 'doc-1')
    const outcome = await replayJournal(repro, fresh.session)
    expect(outcome.ok).toBe(true)
    expect(docHashOf(fresh.cell.current)).toBe(docHashOf(recorded.cell.current))
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

  it('rejects a hostile mintIndex instead of seeking forever', async () => {
    const journal = new CommandJournal()
    const recorded = makeSession(sketchDoc(), journal)
    recorded.session.execute({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] })
    const repro = journal.repro()!

    const infinite: ReproPayload = structuredClone(repro)
    infinite.journal[0].mintIndex = Infinity
    const first = await replayJournal(infinite, makeSession(structuredClone(repro.doc) as PartDoc, undefined, 'doc-1').session)
    expect(first.ok).toBe(false)
    expect(first.steps[0].error?.code).toBe('invalid-mint-index')
    expect(first.steps[0].actualHash).toBeNull()

    const absurd: ReproPayload = structuredClone(repro)
    absurd.journal[0].mintIndex = Number.MAX_SAFE_INTEGER
    const second = await replayJournal(absurd, makeSession(structuredClone(repro.doc) as PartDoc, undefined, 'doc-1').session)
    expect(second.ok).toBe(false)
    expect(second.steps[0].error?.code).toBe('invalid-mint-index')
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
