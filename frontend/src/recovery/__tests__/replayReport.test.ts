// @vitest-environment node
//
// A crash report replays to the doc hash it recorded. The recording session
// draws a real crypto generation seed (the browser's context), the report
// captures the journal's repro alongside the live snapshot, and a fresh
// session without a sink of its own replays the payload alone to the same
// final hash.
import { describe, it, expect, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createDocSession, type DocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { CommandJournal, journalSink } from '@/drive/journal'
import { docHashOf } from '@/drive/docHash'
import { recordCrashReport, type CrashReportRecord } from '@/recovery/crashReports'
import { crashReportFinalHash, replayCrashReport } from '@/recovery/__tests__/replayReport'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { setIdSource } from '@/utils/yamlMutations'
import { resetDbConnection } from '@/stores/documentStore/idb'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'

afterEach(() => {
  setIdSource(null)
})

interface Harness {
  session: DocSession
  cell: { current: PartDoc | null }
  journal: CommandJournal | null
}

// The replay session must run WITHOUT a journal sink: a sink would install its
// own generation's id source over the one replayJournal installs, and the
// internally minted ids would come from the wrong sequence.
function makeSession(journal?: CommandJournal): Harness {
  const cell: { current: PartDoc | null } = { current: makeDoc(makeSketch('sk1')) }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve: createFakeSolveScheduler<PartDoc>(),
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
    dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
    docId: 'doc-1',
    ...(journal && { journal: journalSink(journal) }),
  })
  return { session, cell, journal: journal ?? null }
}

const addExtrude = (featureId: string, distance: number): Mutation =>
  ({ type: 'add_extrude', featureId, label: featureId, sketchQuery: '$sk1', distance })

// Record a crash report the way the boundary does: the live doc snapshot and
// the session's mutation tail at crash time.
function recordFrom(h: Harness): Promise<CrashReportRecord | null> {
  return recordCrashReport({
    source: 'boundary',
    message: 'replay fixture',
    snapshot: {
      docId: 'doc-1',
      workspace: 'ws-1',
      docName: 'Fixture',
      doc: h.cell.current,
      repro: h.journal?.repro() ?? null,
    },
  })
}

describe('replayCrashReport', () => {
  it('replays a recorded report to the same doc hash', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetDbConnection()

    const recorded = makeSession(new CommandJournal())
    recorded.session.execute(addExtrude('ex1', 5))
    // add_rect mints its entities and constraints internally, so the replay
    // proves the seed and the per-entry source position travelled in the
    // report, not just the payloads.
    recorded.session.execute({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] })
    const report = await recordFrom(recorded)
    expect(report?.repro).not.toBeNull()
    const expectedFinal = crashReportFinalHash(report!)
    expect(expectedFinal).toBe(docHashOf(recorded.cell.current))

    // A fresh session, started from the report's baseline, replays the payload
    // alone. No settle: the fake scheduler never writes back, so the hashes
    // are the recorded synchronous ones.
    const fresh = makeSession()
    fresh.cell.current = structuredClone(report!.repro!.doc) as PartDoc
    const outcome = await replayCrashReport(report!, fresh.session)
    expect(outcome).not.toBeNull()
    expect(outcome!.ok).toBe(true)
    expect(outcome!.finalHash).toBe(expectedFinal)
    expect(docHashOf(fresh.cell.current)).toBe(expectedFinal)
  })

  it('has nothing to replay when the report carries no repro', async () => {
    globalThis.indexedDB = new IDBFactory()
    resetDbConnection()

    const report = await recordCrashReport({
      source: 'boundary',
      message: 'empty fixture',
      snapshot: { docId: null, workspace: null, docName: '', doc: null, repro: null },
    })
    const session = makeSession()
    expect(replayCrashReport(report!, session.session)).toBeNull()
    expect(crashReportFinalHash(report!)).toBeNull()
  })
})
