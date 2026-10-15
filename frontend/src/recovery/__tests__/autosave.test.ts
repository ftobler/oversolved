// @vitest-environment node
//
// The autosave against a real DocSession (fake scheduler) and fake-indexeddb:
// the debounce coalesces a burst, the record holds the latest doc with the
// session's mutation tail, an explicit save clears it, a failed write surfaces
// without touching the in-memory doc, and the registry flush reads the session
// directly.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { createDocSession, type DocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { CommandJournal, journalSink } from '@/drive/journal'
import { docHashOf } from '@/drive/docHash'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import {
  RECOVERY_DEBOUNCE_MS,
  attachAutosave,
  flushRecoveryEditor,
  recoveryEditorSnapshot,
  registerRecoveryEditor,
  resetRecoveryEditor,
  useAutosaveStore,
} from '@/recovery/autosave'
import { readRecoveryJournal, type RecoveryJournalStore } from '@/recovery/journal'
import { resetDbConnection } from '@/stores/documentStore/idb'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

beforeEach(freshDb)
afterEach(() => {
  resetRecoveryEditor()
  vi.useRealTimers()
})

const sketchDoc = (): PartDoc => makeDoc(makeSketch('sk1'))

const addExtrude = (featureId: string, distance: number): Mutation =>
  ({ type: 'add_extrude', featureId, label: featureId, sketchQuery: '$sk1', distance })

interface Harness {
  session: DocSession
  cell: { current: PartDoc | null }
  dirtyFacts: { dirty: boolean; saves: number; savedHash: number | null }
  journal: CommandJournal
}

function makeHarness(journal: CommandJournal = new CommandJournal()): Harness {
  const cell: { current: PartDoc | null } = { current: sketchDoc() }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const dirtyFacts = { dirty: false, saves: 0, savedHash: null as number | null }
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve: createFakeSolveScheduler<PartDoc>(),
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
    dirtyFacts: () => dirtyFacts,
    docId: 'doc-1',
    journal: journalSink(journal),
  })
  return { session, cell, dirtyFacts, journal }
}

// Only the debounce clock is faked. fake-indexeddb's request chain schedules
// through its own task queue, which stays real, so a read or a flush settles on
// the ordinary event loop while the timer under test does not fire on its own.
function fakeDebounceClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

// The debounce fires and the flush's write runs to completion.
async function settleDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)
}

describe('the recovery autosave', () => {
  it('writes the latest doc and the mutation tail after the debounce', async () => {
    fakeDebounceClock()
    const harness = makeHarness()
    const handle = attachAutosave({
      session: harness.session,
      docId: 'doc-1',
      workspace: 'ws-1',
      getRepro: () => harness.journal.repro(),
    })

    harness.session.execute(addExtrude('ex1', 1))
    harness.session.execute(addExtrude('ex2', 2))
    harness.session.execute(addExtrude('ex3', 3))
    // Nothing is written before the debounce window closes.
    expect(await readRecoveryJournal('doc-1')).toBeUndefined()

    await settleDebounce()
    const record = await readRecoveryJournal('doc-1')
    expect(record).toBeDefined()
    expect(record!.doc).toEqual(harness.cell.current)
    expect(record!.docHash).toBe(docHashOf(harness.cell.current))
    expect(record!.repro!.journal).toHaveLength(3)
    expect(useAutosaveStore.getState().status).toBe('saved')
    handle.dispose()
  })

  it('coalesces a mutation burst into one write and keeps the earlier doc until the window closes', async () => {
    fakeDebounceClock()
    const writes: string[] = []
    const store: RecoveryJournalStore = {
      read: async () => undefined,
      write: async record => { writes.push(record.docHash) },
      clear: async () => {},
    }
    const harness = makeHarness()
    const handle = attachAutosave({
      session: harness.session,
      docId: 'doc-1',
      workspace: null,
      getRepro: () => null,
      store,
    })

    // The first mutation's write lands, then the second falls inside the next
    // debounce window and replaces the first record in place.
    harness.session.execute(addExtrude('ex1', 1))
    await settleDebounce()
    expect(writes).toHaveLength(1)
    const firstHash = writes[0]

    harness.session.execute(addExtrude('ex2', 2))
    await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS / 2)
    harness.session.execute(addExtrude('ex3', 3))
    await settleDebounce()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe(docHashOf(harness.cell.current))
    expect(writes[1]).not.toBe(firstHash)
    handle.dispose()
  })

  it('clears the journal once an explicit save makes the doc clean again', async () => {
    fakeDebounceClock()
    const harness = makeHarness()
    const handle = attachAutosave({
      session: harness.session,
      docId: 'doc-1',
      workspace: 'ws-1',
      getRepro: () => harness.journal.repro(),
    })

    harness.session.execute(addExtrude('ex1', 1))
    await settleDebounce()
    expect(await readRecoveryJournal('doc-1')).toBeDefined()

    // The save seam: the adapter consumes the session's dirty decision and the
    // store's facts now describe the stored bytes.
    harness.session.noteSaved()
    harness.dirtyFacts.dirty = false
    await handle.flush()
    expect(await readRecoveryJournal('doc-1')).toBeUndefined()
    expect(useAutosaveStore.getState().status).toBe('idle')
    handle.dispose()
  })

  it('reports a rejected write and leaves the in-memory doc untouched', async () => {
    fakeDebounceClock()
    const harness = makeHarness()
    const handle = attachAutosave({
      session: harness.session,
      docId: 'doc-1',
      workspace: 'ws-1',
      getRepro: () => null,
      store: {
        read: async () => undefined,
        write: async () => { throw new Error('quota exceeded') },
        clear: async () => {},
      },
    })

    harness.session.execute(addExtrude('ex1', 1))
    const live = harness.cell.current
    await settleDebounce()

    expect(useAutosaveStore.getState().status).toBe('error')
    expect(useAutosaveStore.getState().error).toContain('quota exceeded')
    // The doc is exactly where the session left it: a failed shadow write is a
    // banner, never a lost edit.
    expect(harness.session.getDoc()).toBe(live)
    expect(harness.session.isDirty()).toBe(true)
    handle.dispose()
  })

  it('flushes the registered editor through the registry, reading the session directly', async () => {
    const harness = makeHarness()
    const handle = attachAutosave({
      session: harness.session,
      docId: 'doc-1',
      workspace: 'ws-1',
      getRepro: () => harness.journal.repro(),
      getName: () => 'Bracket',
    })
    registerRecoveryEditor(handle)
    harness.session.execute(addExtrude('ex1', 1))

    flushRecoveryEditor()
    const snapshot = recoveryEditorSnapshot()
    expect(snapshot?.doc).toBe(harness.cell.current)
    expect(snapshot?.docName).toBe('Bracket')
    expect(snapshot?.docId).toBe('doc-1')
    // The fire-and-forget flush still lands the record.
    await vi.waitFor(async () => {
      expect((await readRecoveryJournal('doc-1'))?.docHash).toBe(docHashOf(harness.cell.current))
    })
    handle.dispose()
  })
})
