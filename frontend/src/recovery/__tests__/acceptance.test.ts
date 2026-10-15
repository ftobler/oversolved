// @vitest-environment node
//
// The acceptance sentence end to end at the module seams: kill the tab
// mid-edit, reopen, and the offer carries every mutation old enough to have
// flushed, losing at most the debounce window. A real DocSession feeds the
// autosave, a real CommandJournal rides along as the repro tail, and the
// reopen side is the same findRecoveryOffer the workspace page calls, judged
// against the bytes the store would have held.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { stringify as stringifyYaml } from 'yaml'
import { createDocSession, type DocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { CommandJournal, journalSink } from '@/drive/journal'
import { docHashOf } from '@/drive/docHash'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import {
  RECOVERY_DEBOUNCE_MS,
  attachAutosave,
} from '@/recovery/autosave'
import { findRecoveryOffer } from '@/recovery/offer'
import { resetDbConnection } from '@/stores/documentStore/idb'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'

function freshDb(): void {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
}

beforeEach(freshDb)
afterEach(() => { vi.useRealTimers() })

const storedDoc = (): PartDoc => makeDoc(makeSketch('sk1'))

const addExtrude = (featureId: string, distance: number): Mutation =>
  ({ type: 'add_extrude', featureId, label: featureId, sketchQuery: '$sk1', distance })

interface Harness {
  session: DocSession
  cell: { current: PartDoc | null }
  journal: CommandJournal
}

function makeEditor(): Harness {
  const cell: { current: PartDoc | null } = { current: storedDoc() }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const journal = new CommandJournal()
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve: createFakeSolveScheduler<PartDoc>(),
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
    dirtyFacts: () => ({ dirty: true, saves: 0, savedHash: null }),
    docId: 'doc-1',
    journal: journalSink(journal),
  })
  return { session, cell, journal }
}

describe('kill-tab recovery acceptance', () => {
  it('offers the flushed edits at reopen and loses nothing older than the debounce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const editor = makeEditor()
    const handle = attachAutosave({
      session: editor.session,
      docId: 'doc-1',
      workspace: 'ws-1',
      getRepro: () => editor.journal.repro(),
    })

    editor.session.execute(addExtrude('ex1', 1))
    editor.session.execute(addExtrude('ex2', 2))
    editor.session.execute(addExtrude('ex3', 3))
    await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)

    // An edit still inside the debounce window when the tab dies; the window is
    // the accepted loss, so the journal keeps the last flushed doc.
    editor.session.execute(addExtrude('ex4', 4))
    handle.dispose()

    // Reopen: the stored bytes are the pre-edit document, so the offer must be
    // made and must carry the three flushed mutations, not the fourth.
    const offer = await findRecoveryOffer('ws-1', 'doc-1', stringifyYaml(storedDoc()))
    expect(offer).not.toBeNull()
    expect(offer!.record.docHash).toBe(docHashOf(offer!.record.doc))
    expect(offer!.record.doc.features?.map(f => f.id)).toEqual(
      expect.arrayContaining(['sk1', 'ex1', 'ex2', 'ex3']),
    )
    expect(offer!.record.doc.features?.some(f => f.id === 'ex4')).toBe(false)
    // The repro tail travels with the record, so the crash-report path can
    // replay the flushed sequence.
    expect(offer!.record.repro?.journal).toHaveLength(3)
  })

  it('does not offer a journal that matches the stored bytes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const editor = makeEditor()
    const handle = attachAutosave({
      session: editor.session,
      docId: 'doc-1',
      workspace: 'ws-1',
      getRepro: () => editor.journal.repro(),
    })

    // An edit that was flushed and then undone back to the stored content: the
    // surviving record matches the store byte for byte, so reopen has nothing
    // to ask about even though a record exists.
    editor.session.execute(addExtrude('ex1', 1))
    await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)
    editor.session.undo()
    await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)
    handle.dispose()

    expect(await findRecoveryOffer('ws-1', 'doc-1', stringifyYaml(storedDoc()))).toBeNull()
  })
})
